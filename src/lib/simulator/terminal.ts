// ============================================================
// SimTerminal - a simulated MT5 terminal (the "connector" side).
//
// It owns an in-memory account + position book, executes engine
// commands with realistic latency / broker rejects, runs its own
// SL/TP and pending-fill triggers on market ticks, and emits the
// SAME TradeEvent stream a real MQL5 EA would send.
//
// DB persistence of positions/closed trades is owned by the
// engine (single writer); this terminal only keeps live state in
// memory and is restored from DB rows on process restart.
// ============================================================

import type {
  CommandResult,
  SymbolSpec,
  TerminalCommand,
  TerminalStatus,
  TradeEvent,
} from '@/lib/types'
import { round2, roundPrice } from '@/lib/engine/lotcalc'
import { getMarket } from './market'

export interface SimPosition {
  ticket: string
  symbol: string // local name as seen by this terminal (after aliasing)
  canonical: string // canonical market symbol
  side: 'buy' | 'sell'
  kind: 'position' | 'pending'
  pendingType: string
  volume: number
  openPrice: number
  sl: number
  tp: number
  openTime: number
  masterTicket: string
  eventKey: string
}

export interface SimAccount {
  balance: number
  equity: number
  floatingPL: number
  freeMargin: number
  marginLevel: number
}

export type EmitFn = (terminalId: string, evt: TradeEvent) => void

const PENDING_TYPES = [
  'buylimit',
  'selllimit',
  'buystop',
  'sellstop',
  'buystoplimit',
  'sellstoplimit',
] as const

export class SimTerminal {
  readonly id: string
  name = ''
  status: TerminalStatus = 'disconnected'
  balance: number
  readonly baseBalance: number
  leverage = 100
  rejectProbability = 0.03
  baseLatencyMs = 8
  jitterMs = 25
  /** canonical -> local symbol name (e.g. XAUUSD -> GOLD). Master: empty. */
  aliases: Record<string, string> = {}

  private positions: SimPosition[] = []
  private emit: EmitFn
  private ticketCounter = 0

  constructor(input: {
    id: string
    balance: number
    emit: EmitFn
    aliases?: Record<string, string>
  }) {
    this.id = input.id
    this.balance = round2(input.balance)
    this.baseBalance = round2(input.balance)
    this.emit = input.emit
    this.aliases = input.aliases ?? {}
  }

  // ---------- symbol aliasing ----------

  toCanonical(localSymbol: string): string | null {
    const up = localSymbol.toUpperCase()
    // Reverse alias lookup: aliases maps canonical -> local, find the key
    // whose local name matches the requested symbol (e.g. GOLD -> XAUUSD).
    for (const [canon, local] of Object.entries(this.aliases)) {
      if (local.toUpperCase() === up) return canon
    }
    // direct canonical name
    return getMarket().getSpec(up) ? up : null
  }

  toLocal(canonical: string): string {
    return this.aliases[canonical.toUpperCase()] ?? canonical
  }

  getSymbolSpec(localSymbol: string): SymbolSpec | null {
    const canon = this.toCanonical(localSymbol)
    if (!canon) return null
    return getMarket().getSpec(canon)
  }

  // ---------- restore ----------

  /** Restore open positions from the engine-maintained DB mirror. */
  restorePositions(
    rows: {
      ticket: string
      symbol: string
      side: string
      kind: string
      pendingType: string
      volume: number
      openPrice: number
      sl: number
      tp: number
      openTime: number
      masterTicket: string
    }[],
  ): void {
    this.positions = rows.map((r) => {
      const canon = this.toCanonical(r.symbol) ?? r.symbol.toUpperCase()
      return {
        ticket: r.ticket,
        symbol: r.symbol,
        canonical: canon,
        side: r.side === 'sell' ? 'sell' : 'buy',
        kind: r.kind === 'pending' ? 'pending' : 'position',
        pendingType: r.pendingType,
        volume: r.volume,
        openPrice: r.openPrice,
        sl: r.sl,
        tp: r.tp,
        openTime: r.openTime,
        masterTicket: r.masterTicket,
        eventKey: '',
      }
    })
  }

  snapshotPositions(): SimPosition[] {
    return [...this.positions]
  }

  // ---------- market ticks ----------

  /** Called on every market tick: update prices, trigger SL/TP/fills. */
  applyTick(): void {
    const market = getMarket()
    for (const p of [...this.positions]) {
      const spec = market.getSpec(p.canonical)
      if (!spec) continue
      const px = market.getPrice(p.canonical)
      if (!px) continue
      if (p.kind === 'pending') {
        this.checkPendingFill(p, px.price)
        continue
      }
      // SL/TP triggers
      if (p.side === 'buy') {
        if (p.sl > 0 && px.price <= p.sl) {
          this.finishPosition(p, p.sl, 'sl')
          continue
        }
        if (p.tp > 0 && px.price >= p.tp) {
          this.finishPosition(p, p.tp, 'tp')
          continue
        }
      } else {
        if (p.sl > 0 && px.price >= p.sl) {
          this.finishPosition(p, p.sl, 'sl')
          continue
        }
        if (p.tp > 0 && px.price <= p.tp) {
          this.finishPosition(p, p.tp, 'tp')
          continue
        }
      }
    }
  }

  private checkPendingFill(p: SimPosition, price: number): void {
    const t = p.pendingType
    const fill =
      (t === 'buylimit' && price <= p.openPrice) ||
      (t === 'selllimit' && price >= p.openPrice) ||
      (t === 'buystop' && price >= p.openPrice) ||
      (t === 'sellstop' && price <= p.openPrice) ||
      (t === 'buystoplimit' && price <= p.openPrice) ||
      (t === 'sellstoplimit' && price >= p.openPrice)
    if (!fill) return
    // convert pending -> position
    p.kind = 'position'
    p.pendingType = ''
    this.emit(this.id, {
      type: 'pending_filled',
      ticket: p.ticket,
      symbol: p.symbol,
      side: p.side,
      volume: p.volume,
      price: p.openPrice,
      sl: p.sl,
      tp: p.tp,
      ts: Date.now(),
    })
  }

  private positionProfit(p: SimPosition): number {
    const spec = getMarket().getSpec(p.canonical)
    if (!spec) return 0
    const px = getMarket().getPrice(p.canonical)
    if (!px) return 0
    const cur = p.kind === 'pending' ? p.openPrice : px.price
    const valuePerPointPerLot = spec.tickValue * (spec.point / spec.tickSize)
    const diff = p.side === 'buy' ? cur - p.openPrice : p.openPrice - cur
    return round2((diff / spec.point) * p.volume * valuePerPointPerLot)
  }

  /** USD notional of 1.0 lot (for margin). Base-USD pairs use fixed contract. */
  private notionalUsd(canonical: string, price: number): number {
    const spec = getMarket().getSpec(canonical)
    if (!spec) return 0
    // Pairs quoted as USD/xxx (USDJPY, USDCAD, ...): 1 lot = 100k USD base.
    if (canonical.startsWith('USD')) return spec.contractSize
    return spec.contractSize * price
  }

  account(): SimAccount {
    let floating = 0
    let usedMargin = 0
    for (const p of this.positions) {
      if (p.kind !== 'position') continue
      floating += this.positionProfit(p)
      const px = getMarket().getPrice(p.canonical)
      if (px) usedMargin += (p.volume * this.notionalUsd(p.canonical, px.price)) / this.leverage
    }
    const equity = round2(this.balance + floating)
    return {
      balance: round2(this.balance),
      equity,
      floatingPL: round2(floating),
      freeMargin: round2(equity - usedMargin),
      marginLevel: usedMargin > 0 ? round2((equity / usedMargin) * 100) : 0,
    }
  }

  openPositionsCount(): number {
    return this.positions.filter((p) => p.kind === 'position').length
  }

  // ---------- command execution ----------

  private async delay(): Promise<void> {
    const ms = this.baseLatencyMs + Math.random() * Math.max(0, this.jitterMs)
    await new Promise((r) => setTimeout(r, ms))
  }

  private rejectRoll(): boolean {
    return Math.random() < this.rejectProbability
  }

  private normalizeVolume(volume: number, spec: SymbolSpec, maxLotLimit?: number): {
    ok: boolean
    volume: number
    code?: string
    error?: string
  } {
    const cap = Math.min(spec.volumeMax, maxLotLimit && maxLotLimit > 0 ? maxLotLimit : spec.volumeMax)
    if (!Number.isFinite(volume) || volume <= 0) {
      return { ok: false, volume: 0, code: 'invalid_volume', error: 'Volume must be positive' }
    }
    if (volume < spec.volumeMin) {
      return {
        ok: false,
        volume: 0,
        code: 'invalid_volume',
        error: `Volume ${volume} below broker minimum ${spec.volumeMin}`,
      }
    }
    // floor to step, then clamp
    const stepped = Math.floor(volume / spec.volumeStep + 1e-9) * spec.volumeStep
    const clamped = Math.min(Math.max(round2(stepped), spec.volumeMin), cap)
    if (clamped < spec.volumeMin) {
      return {
        ok: false,
        volume: 0,
        code: 'invalid_volume',
        error: `Volume ${volume} cannot be normalized to broker constraints`,
      }
    }
    return { ok: true, volume: round2(clamped) }
  }

  private newTicket(): string {
    let t = ''
    do {
      t = String(80_000_000 + ((this.ticketCounter++ * 7919 + Date.now()) % 9_999_999))
    } while (this.positions.some((p) => p.ticket === t))
    return t
  }

  /** Execute a command coming from the engine (or the hub controls). */
  async handleCommand(cmd: TerminalCommand): Promise<CommandResult> {
    const done = (r: Omit<CommandResult, 'at'>): CommandResult => ({ ...r, at: Date.now() })
    if (this.status !== 'connected') {
      return done({ ok: false, error: 'Terminal is not connected', code: 'offline' })
    }
    await this.delay()
    const market = getMarket()

    if (cmd.kind === 'open') {
      const canon = this.toCanonical(cmd.symbol)
      const spec = canon ? market.getSpec(canon) : null
      if (!canon || !spec) {
        return done({ ok: false, error: `Unknown symbol ${cmd.symbol}`, code: 'unknown_symbol' })
      }
      const vol = this.normalizeVolume(cmd.volume ?? 0, spec)
      if (!vol.ok) return done({ ok: false, error: vol.error, code: vol.code })
      if (this.rejectRoll()) {
        return done({
          ok: false,
          error: 'Broker rejected: requotes / price off',
          code: 'broker_reject',
        })
      }
      const px = market.getPrice(canon)
      if (!px) return done({ ok: false, error: 'No quotes', code: 'market_closed' })
      const side = cmd.side === 'sell' ? 'sell' : 'buy'
      const slip = (Math.random() * 3) | 0
      const price = roundPrice(
        side === 'buy' ? px.price + slip * spec.point : px.price - slip * spec.point,
        spec.digits,
      )
      const pos: SimPosition = {
        ticket: this.newTicket(),
        symbol: this.toLocal(canon),
        canonical: canon,
        side,
        kind: 'position',
        pendingType: '',
        volume: vol.volume,
        openPrice: price,
        sl: cmd.sl ?? 0,
        tp: cmd.tp ?? 0,
        openTime: Date.now(),
        masterTicket: cmd.masterTicket ?? '',
        eventKey: cmd.eventKey ?? '',
      }
      this.positions.push(pos)
      this.emit(this.id, {
        type: 'position_opened',
        ticket: pos.ticket,
        symbol: pos.symbol,
        side,
        volume: pos.volume,
        price,
        sl: pos.sl,
        tp: pos.tp,
        ts: Date.now(),
      })
      return done({ ok: true, ticket: pos.ticket, price })
    }

    if (cmd.kind === 'close' || cmd.kind === 'partial') {
      const pos = this.positions.find((p) => p.ticket === cmd.ticket)
      if (!pos) {
        return done({
          ok: false,
          error: `Position ${cmd.ticket} not found`,
          code: 'not_found',
        })
      }
      if (pos.kind === 'pending') {
        // closing a pending = cancel
        this.positions = this.positions.filter((p) => p.ticket !== pos.ticket)
        this.emit(this.id, {
          type: 'pending_cancelled',
          ticket: pos.ticket,
          symbol: pos.symbol,
          volume: pos.volume,
          price: pos.openPrice,
          ts: Date.now(),
        })
        return done({ ok: true, ticket: pos.ticket, price: pos.openPrice })
      }
      const spec = market.getSpec(pos.canonical)
      const px = market.getPrice(pos.canonical)
      if (!spec || !px) return done({ ok: false, error: 'No quotes', code: 'market_closed' })

      if (cmd.kind === 'close') {
        const profit = this.positionProfit(pos)
        this.balance = round2(this.balance + profit)
        this.positions = this.positions.filter((p) => p.ticket !== pos.ticket)
        this.emit(this.id, {
          type: 'position_closed',
          ticket: pos.ticket,
          symbol: pos.symbol,
          side: pos.side,
          volume: pos.volume,
          price: px.price,
          closeReason: 'engine',
          ts: Date.now(),
        })
        return done({ ok: true, ticket: pos.ticket, price: px.price })
      }

      // partial close
      const specChk = this.normalizeVolume(pos.volume, spec)
      const closedVol = this.normalizeVolume(cmd.volume ?? 0, spec)
      if (!closedVol.ok) {
        return done({ ok: false, error: closedVol.error, code: closedVol.code })
      }
      const remaining = round2(pos.volume - closedVol.volume)
      if (remaining < spec.volumeMin) {
        // broker closes fully when remainder below min lot
        const profit = this.positionProfit(pos)
        this.balance = round2(this.balance + profit)
        this.positions = this.positions.filter((p) => p.ticket !== pos.ticket)
        this.emit(this.id, {
          type: 'position_closed',
          ticket: pos.ticket,
          symbol: pos.symbol,
          side: pos.side,
          volume: pos.volume,
          closedVolume: closedVol.volume,
          price: px.price,
          closeReason: 'partial_full',
          ts: Date.now(),
        })
        return done({ ok: true, ticket: pos.ticket, price: px.price })
      }
      const preProfit = this.positionProfit(pos)
      const closedProfit = round2((preProfit * closedVol.volume) / Math.max(pos.volume, 1e-9))
      this.balance = round2(this.balance + closedProfit)
      pos.volume = remaining
      this.emit(this.id, {
        type: 'partial_closed',
        ticket: pos.ticket,
        symbol: pos.symbol,
        side: pos.side,
        volume: remaining,
        closedVolume: closedVol.volume,
        price: px.price,
        sl: pos.sl,
        tp: pos.tp,
        ts: Date.now(),
      })
      void specChk
      return done({ ok: true, ticket: pos.ticket, price: px.price })
    }

    if (cmd.kind === 'modify_sltp') {
      const pos = this.positions.find((p) => p.ticket === cmd.ticket)
      if (!pos || pos.kind !== 'position') {
        return done({ ok: false, error: `Position ${cmd.ticket} not found`, code: 'not_found' })
      }
      pos.sl = cmd.sl ?? 0
      pos.tp = cmd.tp ?? 0
      this.emit(this.id, {
        type: 'sltp_modified',
        ticket: pos.ticket,
        symbol: pos.symbol,
        side: pos.side,
        volume: pos.volume,
        price: pos.openPrice,
        sl: pos.sl,
        tp: pos.tp,
        ts: Date.now(),
      })
      return done({ ok: true, ticket: pos.ticket })
    }

    if (cmd.kind === 'place_pending') {
      const canon = this.toCanonical(cmd.symbol)
      const spec = canon ? market.getSpec(canon) : null
      if (!canon || !spec) {
        return done({ ok: false, error: `Unknown symbol ${cmd.symbol}`, code: 'unknown_symbol' })
      }
      const vol = this.normalizeVolume(cmd.volume ?? 0, spec)
      if (!vol.ok) return done({ ok: false, error: vol.error, code: vol.code })
      const ptype = (cmd.pendingType ?? '').toLowerCase()
      if (!PENDING_TYPES.includes(ptype as (typeof PENDING_TYPES)[number])) {
        return done({ ok: false, error: `Invalid pending type ${ptype}`, code: 'invalid_pending' })
      }
      if (this.rejectRoll()) {
        return done({ ok: false, error: 'Broker rejected pending', code: 'broker_reject' })
      }
      const px = market.getPrice(canon)
      if (!px) return done({ ok: false, error: 'No quotes', code: 'market_closed' })
      const pos: SimPosition = {
        ticket: this.newTicket(),
        symbol: this.toLocal(canon),
        canonical: canon,
        side: cmd.side === 'sell' ? 'sell' : 'buy',
        kind: 'pending',
        pendingType: ptype,
        volume: vol.volume,
        openPrice: cmd.price ?? px.price,
        sl: cmd.sl ?? 0,
        tp: cmd.tp ?? 0,
        openTime: Date.now(),
        masterTicket: cmd.masterTicket ?? '',
        eventKey: cmd.eventKey ?? '',
      }
      this.positions.push(pos)
      this.emit(this.id, {
        type: 'pending_placed',
        ticket: pos.ticket,
        symbol: pos.symbol,
        side: pos.side,
        volume: pos.volume,
        price: pos.openPrice,
        sl: pos.sl,
        tp: pos.tp,
        pendingType: ptype,
        ts: Date.now(),
      })
      return done({ ok: true, ticket: pos.ticket, price: pos.openPrice })
    }

    if (cmd.kind === 'cancel_pending') {
      const pos = this.positions.find((p) => p.ticket === cmd.ticket && p.kind === 'pending')
      if (!pos) return done({ ok: false, error: `Pending ${cmd.ticket} not found`, code: 'not_found' })
      this.positions = this.positions.filter((p) => p.ticket !== pos.ticket)
      this.emit(this.id, {
        type: 'pending_cancelled',
        ticket: pos.ticket,
        symbol: pos.symbol,
        volume: pos.volume,
        price: pos.openPrice,
        ts: Date.now(),
      })
      return done({ ok: true, ticket: pos.ticket })
    }

    return done({ ok: false, error: `Unsupported command ${(cmd as { kind?: string }).kind}`, code: 'bad_command' })
  }

  /** Local close used by SL/TP triggers and hub helpers (bypasses command latency). */
  private finishPosition(p: SimPosition, closePrice: number, reason: 'sl' | 'tp'): void {
    const profit = this.positionProfit(p)
    this.balance = round2(this.balance + profit)
    this.positions = this.positions.filter((x) => x.ticket !== p.ticket)
    this.emit(this.id, {
      type: 'position_closed',
      ticket: p.ticket,
      symbol: p.symbol,
      side: p.side,
      volume: p.volume,
      price: closePrice,
      closeReason: reason,
      ts: Date.now(),
    })
  }

  /** Wipe local book (used by resetAll). */
  resetBook(): void {
    this.positions = []
    this.balance = this.baseBalance
  }
}
