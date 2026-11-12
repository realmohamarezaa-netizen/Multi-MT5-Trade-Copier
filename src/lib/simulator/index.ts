// ============================================================
// SimulatorHub - orchestrates all simulated MT5 terminals.
//
// Registers one TerminalLink per terminal into the engine (the
// same interface a real Python/MQL5 bridge would implement),
// drives market ticks, auto-trading on the master, auto-reconnect
// and account pushes. Also exposes the control surface used by
// the simulator UI and the acceptance-test runner.
// ============================================================

import { db } from '@/lib/db'
import type { CopierEngine } from '@/lib/engine'
import { logEvent } from '@/lib/engine/logger'
import { parseSymbolMapping, round2, roundPrice } from '@/lib/engine/lotcalc'
import type {
  SlaveSettingsDTO,
  TerminalCommand,
  TerminalLink,
  TerminalRole,
  TerminalStatus,
  TradeEvent,
} from '@/lib/types'
import { getMarket, type MarketSim } from './market'
import { SimTerminal } from './terminal'

const MAIN_LOOP_MS = 500
const RECONNECT_LOOP_MS = 3000
const CONNECT_DELAY_MS = 700

interface AppSettingsLike {
  masterAutoTrade: boolean
  autoTradeIntervalMs: number
  defaultRejectProbability: number
}

const PENDING_POOL = [
  { pendingType: 'buylimit', side: 'buy' as const },
  { pendingType: 'selllimit', side: 'sell' as const },
  { pendingType: 'buystop', side: 'buy' as const },
  { pendingType: 'sellstop', side: 'sell' as const },
]

const TRADE_SYMBOLS = ['EURUSD', 'GBPUSD', 'USDJPY', 'AUDUSD', 'XAUUSD', 'US30']

export class SimulatorHub {
  private engine: CopierEngine | null = null
  private terminals = new Map<string, SimTerminal>()
  private manualOffline = new Set<string>()
  private started = false
  private startPromise: Promise<void> | null = null
  private mainTimer: ReturnType<typeof setInterval> | null = null
  private reconnectTimer: ReturnType<typeof setInterval> | null = null
  private nextAutoTradeAt = 0
  private settingsCache: AppSettingsLike | null = null
  private settingsCacheAt = 0
  private market: MarketSim
  private connecting = new Set<string>()

  constructor() {
    this.market = getMarket()
    this.emitEvent = () => undefined
  }

  // ---------- lifecycle ----------

  async ensureStarted(engine: CopierEngine): Promise<void> {
    this.engine = engine
    this.bindEngine(engine)
    if (this.started) return
    if (this.startPromise) return this.startPromise
    this.startPromise = this.doStart().finally(() => {
      this.startPromise = null
    })
    return this.startPromise
  }

  private bindEngine(engine: CopierEngine): void {
    this.emitEvent = (terminalId: string, evt: TradeEvent) => {
      void engine.onTradeEvent(terminalId, evt).catch(() => undefined)
    }
  }

  private async doStart(): Promise<void> {
    this.market.ensureRunning()

    // Route engine connection controls into the simulator.
    this.engine?.setConnectionControl({
      connect: (id: string) => this.connectFlow(id),
      disconnect: (id: string) => this.disconnectTerminal(id),
      terminalAdded: (id: string) => this.attachTerminal(id),
      terminalRemoved: (id: string) => this.detachTerminal(id),
    })

    const rows = await db.terminal.findMany({ include: { slaveSettings: true } })
    if (rows.length === 0) {
      await this.bootstrapDefaults()
    } else {
      for (const row of rows) await this.attachTerminal(row.id)
      await logEvent({
        level: 'info',
        category: 'engine',
        message: `Simulator restored ${rows.length} terminal(s) from local database`,
      })
    }

    if (!this.mainTimer) {
      this.mainTimer = setInterval(() => {
        void this.mainLoop().catch(() => undefined)
      }, MAIN_LOOP_MS)
    }
    if (!this.reconnectTimer) {
      this.reconnectTimer = setInterval(() => {
        void this.reconnectLoop().catch(() => undefined)
      }, RECONNECT_LOOP_MS)
    }
    this.started = true
  }

  private emitEvent: (terminalId: string, evt: TradeEvent) => void

  /** Create/refresh the SimTerminal for a DB terminal row and register its link. */
  private async attachTerminal(id: string): Promise<void> {
    if (!this.engine) return
    const row = await db.terminal.findUnique({ where: { id }, include: { slaveSettings: true } })
    if (!row) return
    const existing = this.terminals.get(id)
    if (existing) {
      // refresh live params (e.g. mapping edited from the settings UI)
      existing.aliases = row.slaveSettings ? parseSymbolMapping(row.slaveSettings.symbolMapping) : {}
      existing.name = row.name
      if (row.slaveSettings) {
        existing.rejectProbability = row.slaveSettings.rejectProbability
        existing.baseLatencyMs = row.slaveSettings.baseLatencyMs
        existing.jitterMs = row.slaveSettings.jitterMs
      }
      return
    }
    const aliases = row.slaveSettings ? parseSymbolMapping(row.slaveSettings.symbolMapping) : {}
    const sim = new SimTerminal({
      id,
      balance: row.balance > 0 ? row.balance : 10000,
      emit: (tid: string, evt: TradeEvent) => this.emitEvent(tid, evt),
      aliases,
    })
    sim.name = row.name
    sim.status = row.status === 'connected' ? 'connected' : 'disconnected'
    if (row.slaveSettings) {
      sim.rejectProbability = row.slaveSettings.rejectProbability
      sim.baseLatencyMs = row.slaveSettings.baseLatencyMs
      sim.jitterMs = row.slaveSettings.jitterMs
    }
    // restore open positions from the engine-maintained mirror
    const posRows = await db.position.findMany({ where: { terminalId: id } })
    sim.restorePositions(posRows)
    this.terminals.set(id, sim)
    if (row.status === 'connected') this.manualOffline.delete(id)

    const link: TerminalLink = {
      isConnected: () => sim.status === 'connected',
      send: (cmd: TerminalCommand) => sim.handleCommand(cmd),
      getSymbolSpec: (symbol: string) => sim.getSymbolSpec(symbol),
    }
    this.engine.registerLink(id, link)

    if (row.status === 'disconnected' && !this.manualOffline.has(id)) {
      void this.connectFlow(id)
    }
  }

  private async detachTerminal(id: string): Promise<void> {
    this.terminals.delete(id)
    this.manualOffline.delete(id)
  }

  /** Bootstrap a demo set: 1 master + 3 slaves (one with symbol mapping). */
  private async bootstrapDefaults(): Promise<void> {
    if (!this.engine) return
    await logEvent({
      level: 'info',
      category: 'engine',
      message: 'Empty database detected, bootstrapping demo terminal set (1 master + 3 slaves)',
    })
    const defs = [
      { name: 'MT5-Alpha', broker: 'DemoMarkets Ltd', server: 'DemoMarkets-Demo', balance: 10000, role: 'master' as TerminalRole },
      { name: 'MT5-Beta', broker: 'GlobalFX Inc', server: 'GlobalFX-Demo', balance: 25000, role: 'slave' as TerminalRole },
      { name: 'MT5-Gamma', broker: 'PrimeTrade EU', server: 'PrimeTrade-Demo', balance: 5000, role: 'slave' as TerminalRole },
      { name: 'MT5-Delta', broker: 'Alpine Brokers', server: 'Alpine-Demo', balance: 50000, role: 'slave' as TerminalRole },
    ]
    const ids: Record<string, string> = {}
    for (const d of defs) {
      const dto = await this.engine.addTerminal({ name: d.name, broker: d.broker, server: d.server })
      ids[d.name] = dto.id
      await this.engine.setRole(dto.id, d.role)
      await db.terminal.update({
        where: { id: dto.id },
        data: { balance: d.balance, equity: d.balance, freeMargin: d.balance },
      })
    }
    // Beta gets a realistic symbol mapping (also used as its alias map)
    const betaMapping = 'XAUUSD=GOLD;EURUSD=EURUSD.a'
    await this.engine.updateSlaveSettings(ids['MT5-Beta'], { symbolMapping: betaMapping })
    await this.attachTerminal(ids['MT5-Beta']) // refresh live aliases
    await logEvent({
      level: 'success',
      category: 'settings',
      message: 'Demo set ready: MT5-Alpha (master), MT5-Beta/Gamma/Delta (slaves)',
      details: 'Beta maps XAUUSD=GOLD, EURUSD=EURUSD.a',
    })
  }

  // ---------- loops ----------

  private async getSettings(): Promise<AppSettingsLike> {
    const now = Date.now()
    if (this.settingsCache && now - this.settingsCacheAt < 2000) return this.settingsCache
    const row = await db.appSettings.findUnique({ where: { id: 'singleton' } })
    this.settingsCache = row
      ? {
          masterAutoTrade: row.masterAutoTrade,
          autoTradeIntervalMs: row.autoTradeIntervalMs,
          defaultRejectProbability: row.defaultRejectProbability,
        }
      : { masterAutoTrade: true, autoTradeIntervalMs: 9000, defaultRejectProbability: 0.03 }
    this.settingsCacheAt = now
    return this.settingsCache
  }

  private async mainLoop(): Promise<void> {
    // 1. market ticks -> terminal triggers (SL/TP/pending fills)
    for (const sim of this.terminals.values()) {
      try {
        sim.applyTick()
      } catch {
        // keep the loop alive
      }
    }
    // 2. push account snapshots (engine throttles DB writes)
    if (this.engine) {
      for (const sim of this.terminals.values()) {
        const acc = sim.account()
        void this.engine.onAccountUpdate(sim.id, acc).catch(() => undefined)
      }
    }
    // 3. master auto-trade
    const settings = await this.getSettings()
    const now = Date.now()
    if (settings.masterAutoTrade && now >= this.nextAutoTradeAt) {
      this.nextAutoTradeAt = now + Math.max(2000, settings.autoTradeIntervalMs) + Math.random() * 2000
      const master = await this.getMasterSim()
      if (master && master.status === 'connected') {
        const roll = Math.random()
        try {
          if (roll < 0.62) {
            await this.masterOpenTrade()
          } else if (roll < 0.74) {
            await this.masterCloseTrade()
          } else if (roll < 0.84) {
            await this.masterPartialClose()
          } else if (roll < 0.94) {
            await this.masterModifySLTP()
          } else {
            await this.masterPlacePending()
          }
        } catch {
          // ignore
        }
      }
    }
  }

  private async reconnectLoop(): Promise<void> {
    const rows = await db.terminal.findMany({ select: { id: true, autoReconnect: true } })
    for (const row of rows) {
      if (!row.autoReconnect) continue
      if (this.manualOffline.has(row.id)) continue
      const sim = this.terminals.get(row.id)
      if (!sim) continue
      if (sim.status === 'connected' || sim.status === 'connecting') continue
      if (Math.random() > 0.85) continue // realistic failed attempt
      void this.connectFlow(row.id)
    }
  }

  // ---------- connection flows ----------

  async connectFlow(id: string): Promise<void> {
    const sim = this.terminals.get(id)
    if (!sim || sim.status === 'connected' || this.connecting.has(id)) return
    this.manualOffline.delete(id)
    this.connecting.add(id)
    sim.status = 'connecting'
    if (this.engine) void this.engine.onTerminalStatus(id, 'connecting').catch(() => undefined)
    await new Promise((r) => setTimeout(r, CONNECT_DELAY_MS))
    this.connecting.delete(id)
    if (!this.terminals.has(id)) return
    sim.status = 'connected'
    if (this.engine) void this.engine.onTerminalStatus(id, 'connected').catch(() => undefined)
  }

  async disconnectTerminal(id: string): Promise<void> {
    const sim = this.terminals.get(id)
    if (!sim) return
    this.manualOffline.add(id)
    sim.status = 'disconnected'
    if (this.engine) void this.engine.onTerminalStatus(id, 'disconnected').catch(() => undefined)
  }

  /** Manual status control from the simulator UI / test runner. */
  async setTerminalStatus(id: string, status: TerminalStatus): Promise<void> {
    const sim = this.terminals.get(id)
    if (!sim) return
    if (status === 'connected') {
      await this.connectFlow(id)
      return
    }
    if (status === 'disconnected' || status === 'error') {
      this.manualOffline.add(id)
      sim.status = status
      if (this.engine) void this.engine.onTerminalStatus(id, status).catch(() => undefined)
      return
    }
    sim.status = status
    if (this.engine) void this.engine.onTerminalStatus(id, status).catch(() => undefined)
  }

  async setRejectProbability(id: string, p: number): Promise<void> {
    const v = Math.max(0, Math.min(1, p))
    const sim = this.terminals.get(id)
    if (sim) sim.rejectProbability = v
    await db.slaveSettings.upsert({
      where: { terminalId: id },
      update: { rejectProbability: v },
      create: { terminalId: id, rejectProbability: v },
    })
  }

  spreadSpike(symbol?: string): void {
    this.market.spreadSpike(symbol)
  }

  // ---------- master trade controls ----------

  private async getMasterSim(): Promise<SimTerminal | null> {
    const master = await db.terminal.findFirst({ where: { role: 'master' }, select: { id: true } })
    if (!master) return null
    return this.terminals.get(master.id) ?? null
  }

  private randomSymbol(): string {
    return TRADE_SYMBOLS[Math.floor(Math.random() * TRADE_SYMBOLS.length)]
  }

  private randomVolume(): number {
    return round2(Math.round((0.1 + Math.random() * 0.9) * 100) / 100)
  }

  /** SL/TP levels at a realistic relative distance from the current price. */
  private sltpFor(symbol: string, side: 'buy' | 'sell', price: number): { sl: number; tp: number } {
    const spec = this.market.getSpec(symbol)
    if (!spec) return { sl: 0, tp: 0 }
    const dist = price * (0.0004 + Math.random() * 0.0011)
    const sl = side === 'buy' ? price - dist : price + dist
    const tp = side === 'buy' ? price + dist * 1.6 : price - dist * 1.6
    return {
      sl: roundPrice(sl, spec.digits),
      tp: roundPrice(tp, spec.digits),
    }
  }

  /** Open a market trade on the master (random or specified). Throws on failure. */
  async masterOpenTrade(input?: {
    symbol?: string
    side?: 'buy' | 'sell'
    volume?: number
    sl?: number
    tp?: number
  }): Promise<{ ticket: string }> {
    const master = await this.getMasterSim()
    if (!master) throw new Error('No master terminal')
    const symbol = input?.symbol ?? this.randomSymbol()
    const side: 'buy' | 'sell' = input?.side ?? (Math.random() < 0.5 ? 'buy' : 'sell')
    const volume = input?.volume ?? this.randomVolume()
    let sl = input?.sl ?? 0
    let tp = input?.tp ?? 0
    if (!sl && !tp && Math.random() < 0.7) {
      const px = this.market.getPrice(symbol)
      if (px) {
        const l = this.sltpFor(symbol, side, px.price)
        sl = l.sl
        tp = l.tp
      }
    }
    const cmd: TerminalCommand = { kind: 'open', symbol, side, volume, sl, tp }
    const res = await master.handleCommand(cmd)
    if (!res.ok || !res.ticket) throw new Error(res.error ?? 'open failed')
    return { ticket: res.ticket }
  }

  /** Full-close a master position (random or specified ticket). Throws on failure. */
  async masterCloseTrade(ticket?: string): Promise<{ ticket: string }> {
    const master = await this.getMasterSim()
    if (!master) throw new Error('No master terminal')
    const positions = master.snapshotPositions().filter((p) => p.kind === 'position')
    if (positions.length === 0) throw new Error('No open positions on master')
    const pos = ticket ? positions.find((p) => p.ticket === ticket) : positions[0]
    if (!pos) throw new Error(`Position ${ticket ?? '?'} not found`)
    const res = await master.handleCommand({ kind: 'close', ticket: pos.ticket, symbol: pos.symbol })
    if (!res.ok) throw new Error(res.error ?? 'close failed')
    return { ticket: pos.ticket }
  }

  /** Partial-close a master position (default 50% of its volume). Throws on failure. */
  async masterPartialClose(
    ticket?: string,
    fraction = 0.5,
  ): Promise<{ ticket: string }> {
    const master = await this.getMasterSim()
    if (!master) throw new Error('No master terminal')
    const positions = master.snapshotPositions().filter((p) => p.kind === 'position')
    if (positions.length === 0) throw new Error('No open positions on master')
    const pos = ticket ? positions.find((p) => p.ticket === ticket) : positions[0]
    if (!pos) throw new Error(`Position ${ticket ?? '?'} not found`)
    const spec = this.market.getSpec(pos.canonical)
    if (!spec) throw new Error(`Unknown symbol ${pos.symbol}`)
    const closed = round2(Math.max(spec.volumeMin, Math.floor((pos.volume * fraction) / spec.volumeStep) * spec.volumeStep))
    if (closed >= pos.volume) {
      return this.masterCloseTrade(pos.ticket)
    }
    const res = await master.handleCommand({
      kind: 'partial',
      ticket: pos.ticket,
      symbol: pos.symbol,
      volume: closed,
    })
    if (!res.ok) throw new Error(res.error ?? 'partial failed')
    return { ticket: pos.ticket }
  }

  /** Modify SL/TP of a master position (tightens/moves the levels). Throws on failure. */
  async masterModifySLTP(ticket?: string): Promise<{ ticket: string }> {
    const master = await this.getMasterSim()
    if (!master) throw new Error('No master terminal')
    const positions = master.snapshotPositions().filter((p) => p.kind === 'position')
    if (positions.length === 0) throw new Error('No open positions on master')
    const pos = ticket ? positions.find((p) => p.ticket === ticket) : positions[0]
    if (!pos) throw new Error(`Position ${ticket ?? '?'} not found`)
    const spec = this.market.getSpec(pos.canonical)
    const px = this.market.getPrice(pos.canonical)
    if (!spec || !px) throw new Error(`No quotes for ${pos.symbol}`)
    const dist = px.price * (0.0004 + Math.random() * 0.001)
    const sl = roundPrice(pos.side === 'buy' ? px.price - dist : px.price + dist, spec.digits)
    const tp = roundPrice(pos.side === 'buy' ? px.price + dist * 1.8 : px.price - dist * 1.8, spec.digits)
    const res = await master.handleCommand({
      kind: 'modify_sltp',
      ticket: pos.ticket,
      symbol: pos.symbol,
      sl,
      tp,
    })
    if (!res.ok) throw new Error(res.error ?? 'modify failed')
    return { ticket: pos.ticket }
  }

  /** Place a pending order on the master (random or specified). Throws on failure. */
  async masterPlacePending(input?: {
    symbol?: string
    pendingType?: string
    volume?: number
    price?: number
  }): Promise<{ ticket: string }> {
    const master = await this.getMasterSim()
    if (!master) throw new Error('No master terminal')
    const pick = PENDING_POOL[Math.floor(Math.random() * PENDING_POOL.length)]
    const symbol = input?.symbol ?? this.randomSymbol()
    const pendingType = input?.pendingType ?? pick.pendingType
    const side = (input?.pendingType ? pendingType.startsWith('buy') : pick.side) ? 'buy' : 'sell'
    const volume = input?.volume ?? round2(Math.round((0.1 + Math.random() * 0.4) * 100) / 100)
    const spec = this.market.getSpec(symbol)
    const px = this.market.getPrice(symbol)
    if (!spec || !px) throw new Error(`Unknown symbol ${symbol}`)
    const offset = px.price * (0.0006 + Math.random() * 0.0015)
    const price =
      input?.price ??
      roundPrice(
        pendingType.includes('limit')
          ? side === 'buy'
            ? px.price - offset
            : px.price + offset
          : side === 'buy'
            ? px.price + offset
            : px.price - offset,
        spec.digits,
      )
    const res = await master.handleCommand({
      kind: 'place_pending',
      symbol,
      side: side as 'buy' | 'sell',
      volume,
      price,
      pendingType,
    })
    if (!res.ok || !res.ticket) throw new Error(res.error ?? 'pending failed')
    return { ticket: res.ticket }
  }

  /** Cancel a pending order on the master (random or specified). Throws on failure. */
  async masterCancelPending(ticket?: string): Promise<{ ticket: string }> {
    const master = await this.getMasterSim()
    if (!master) throw new Error('No master terminal')
    const pendings = master.snapshotPositions().filter((p) => p.kind === 'pending')
    if (pendings.length === 0) throw new Error('No pending orders on master')
    const pos = ticket ? pendings.find((p) => p.ticket === ticket) : pendings[0]
    if (!pos) throw new Error(`Pending ${ticket ?? '?'} not found`)
    const res = await master.handleCommand({ kind: 'cancel_pending', ticket: pos.ticket, symbol: pos.symbol })
    if (!res.ok) throw new Error(res.error ?? 'cancel failed')
    return { ticket: pos.ticket }
  }

  // ---------- terminal management / utilities ----------

  async addSimulatedTerminal(role: TerminalRole): Promise<{ id: string }> {
    if (!this.engine) throw new Error('Engine not ready')
    const n = this.terminals.size + 1 + Math.floor(Math.random() * 90)
    const brokers = ['Summit Markets', 'Zenith FX', 'Harbor Trade', 'Nova Brokers', 'Quant Deals']
    const dto = await this.engine.addTerminal({
      name: `MT5-Extra${n}`,
      broker: brokers[Math.floor(Math.random() * brokers.length)],
      server: 'Extra-Demo',
    })
    await this.engine.setRole(dto.id, role)
    await this.connectFlow(dto.id)
    await logEvent({
      level: 'success',
      category: 'connection',
      terminalId: dto.id,
      terminalName: dto.name,
      message: `Simulated terminal added (${role})`,
    })
    return { id: dto.id }
  }

  async removeSimulatedTerminal(id: string): Promise<void> {
    if (!this.engine) return
    await this.engine.removeTerminal(id)
  }

  /** Wipe all trade data; keeps terminals + settings. */
  async resetAll(): Promise<void> {
    await db.position.deleteMany({})
    await db.closedTrade.deleteMany({})
    await db.copyOperation.deleteMany({})
    await db.metricEvent.deleteMany({})
    for (const sim of this.terminals.values()) {
      sim.resetBook()
      await db.terminal.update({
        where: { id: sim.id },
        data: {
          balance: sim.baseBalance,
          equity: sim.baseBalance,
          freeMargin: sim.baseBalance,
          floatingPL: 0,
          closedToday: 0,
        },
      })
    }
    await db.appSettings.updateMany({ data: { lastEventAt: 0 } })
    await logEvent({
      level: 'warn',
      category: 'engine',
      message: 'Simulator reset: all trades, copies and metrics wiped; terminals and settings kept',
    })
  }

  /** Direct access for the test runner. */
  getTerminalSim(id: string): SimTerminal | undefined {
    return this.terminals.get(id)
  }

  listTerminalIds(): string[] {
    return [...this.terminals.keys()]
  }

  isStarted(): boolean {
    return this.started
  }
}

// globalThis singleton: survives Next.js dev hot reloads.
const g = globalThis as unknown as { __copierSimulator?: SimulatorHub }

export function getSimulator(): SimulatorHub {
  if (!g.__copierSimulator) g.__copierSimulator = new SimulatorHub()
  return g.__copierSimulator
}
