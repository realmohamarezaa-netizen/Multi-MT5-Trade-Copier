// ============================================================
// Market simulator: canonical symbol universe + tick loop.
// The market is always CANONICAL; per-terminal aliasing
// (e.g. XAUUSD -> GOLD) lives in the SimulatorHub/SimTerminal.
// ============================================================

import type { SymbolSpec } from '@/lib/types'
import { roundPrice } from '@/lib/engine/lotcalc'

interface SymbolDef {
  symbol: string
  digits: number
  point: number
  tickSize: number
  tickValue: number
  contractSize: number
  volumeMin: number
  volumeMax: number
  volumeStep: number
  basePrice: number
  spreadBase: number
  volFactor: number
}

export interface MarketTick {
  symbol: string
  price: number
  spreadPoints: number
  ts: number
}

export interface MarketTickSnapshot {
  ts: number
  symbols: MarketTick[]
}

const DEFS: SymbolDef[] = [
  {
    symbol: 'EURUSD', digits: 5, point: 0.00001, tickSize: 0.00001, tickValue: 1.0,
    contractSize: 100000, volumeMin: 0.01, volumeMax: 100, volumeStep: 0.01,
    basePrice: 1.08500, spreadBase: 10, volFactor: 0.00006,
  },
  {
    symbol: 'GBPUSD', digits: 5, point: 0.00001, tickSize: 0.00001, tickValue: 1.0,
    contractSize: 100000, volumeMin: 0.01, volumeMax: 100, volumeStep: 0.01,
    basePrice: 1.26500, spreadBase: 14, volFactor: 0.00007,
  },
  {
    symbol: 'USDJPY', digits: 3, point: 0.001, tickSize: 0.001, tickValue: 0.9,
    contractSize: 100000, volumeMin: 0.01, volumeMax: 100, volumeStep: 0.01,
    basePrice: 154.200, spreadBase: 12, volFactor: 0.00006,
  },
  {
    symbol: 'AUDUSD', digits: 5, point: 0.00001, tickSize: 0.00001, tickValue: 1.0,
    contractSize: 100000, volumeMin: 0.01, volumeMax: 100, volumeStep: 0.01,
    basePrice: 0.66000, spreadBase: 12, volFactor: 0.00007,
  },
  {
    symbol: 'XAUUSD', digits: 2, point: 0.01, tickSize: 0.01, tickValue: 1.0,
    contractSize: 100, volumeMin: 0.01, volumeMax: 50, volumeStep: 0.01,
    basePrice: 2330.50, spreadBase: 25, volFactor: 0.00035,
  },
  {
    symbol: 'US30', digits: 1, point: 0.1, tickSize: 0.1, tickValue: 1.0,
    contractSize: 1, volumeMin: 0.1, volumeMax: 50, volumeStep: 0.1,
    basePrice: 39000.0, spreadBase: 300, volFactor: 0.00018,
  },
]

const TICK_MS = 500
const SPIKE_MS = 5000
const SPIKE_FACTOR = 6

export class MarketSim {
  private defs = new Map<string, SymbolDef>()
  private ticks = new Map<string, MarketTick>()
  private spikes = new Map<string, number>()
  private timer: ReturnType<typeof setInterval> | null = null

  constructor() {
    const now = Date.now()
    for (const d of DEFS) {
      this.defs.set(d.symbol, d)
      this.ticks.set(d.symbol, { symbol: d.symbol, price: d.basePrice, spreadPoints: d.spreadBase, ts: now })
    }
  }

  /** Start the 500ms tick loop (idempotent). */
  ensureRunning(): void {
    if (this.timer) return
    this.timer = setInterval(() => {
      try {
        this.tick()
      } catch {
        // keep the market loop alive no matter what
      }
    }, TICK_MS)
  }

  /** Box-Muller gaussian. */
  private gauss(): number {
    const u1 = Math.random() || 1e-9
    const u2 = Math.random()
    return Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2)
  }

  private tick(): void {
    const now = Date.now()
    for (const [sym, d] of this.defs) {
      const cur = this.ticks.get(sym)
      const prevPrice = cur?.price ?? d.basePrice
      // Random walk with small mean reversion toward the anchor price.
      const shock = prevPrice * d.volFactor * this.gauss()
      const meanRev = (d.basePrice - prevPrice) * 0.004
      const price = roundPrice(Math.max(d.point, prevPrice + shock + meanRev), d.digits)
      const spikeUntil = this.spikes.get(sym) ?? 0
      const spike = spikeUntil > now ? SPIKE_FACTOR : 1
      const spreadPoints = Math.max(1, Math.round(d.spreadBase * spike * (1 + Math.random() * 0.6)))
      this.ticks.set(sym, { symbol: sym, price, spreadPoints, ts: now })
    }
  }

  /** Multiply the spread of one (or all) symbols by 6 for 5 seconds. */
  spreadSpike(symbol?: string): void {
    const now = Date.now()
    if (symbol) {
      const key = symbol.toUpperCase()
      if (this.defs.has(key)) this.spikes.set(key, now + SPIKE_MS)
    } else {
      for (const sym of this.defs.keys()) this.spikes.set(sym, now + SPIKE_MS)
    }
  }

  /** Current SymbolSpec for a canonical symbol (with live spread), or null. */
  getSpec(symbol: string): SymbolSpec | null {
    const key = symbol.toUpperCase()
    const d = this.defs.get(key)
    if (!d) return null
    const t = this.ticks.get(key)
    return {
      symbol: d.symbol,
      volumeMin: d.volumeMin,
      volumeMax: d.volumeMax,
      volumeStep: d.volumeStep,
      spreadPoints: t?.spreadPoints ?? d.spreadBase,
      contractSize: d.contractSize,
      tickValue: d.tickValue,
      tickSize: d.tickSize,
      digits: d.digits,
      point: d.point,
    }
  }

  /** Latest price + spread for a canonical symbol, or null. */
  getPrice(symbol: string): { price: number; spreadPoints: number; ts: number } | null {
    const t = this.ticks.get(symbol.toUpperCase())
    if (!t) return null
    return { price: t.price, spreadPoints: t.spreadPoints, ts: t.ts }
  }

  getSnapshotOfAll(): MarketTickSnapshot {
    return { ts: Date.now(), symbols: [...this.ticks.values()] }
  }

  symbols(): string[] {
    return [...this.defs.keys()]
  }
}

// globalThis singleton: survives Next.js dev hot reloads.
const g = globalThis as unknown as { __copierMarket?: MarketSim }

export function getMarket(): MarketSim {
  if (!g.__copierMarket) g.__copierMarket = new MarketSim()
  return g.__copierMarket
}
