// ============================================================
// Volume (lot) calculation, symbol mapping and small numeric
// helpers shared by the engine and the simulator.
// Pure functions only - no I/O.
// ============================================================

import type { LotMode, SymbolSpec } from '@/lib/types'

export interface CalcVolumeInput {
  mode: LotMode
  masterVolume: number
  masterBalance: number
  slaveEquity: number
  fixedLot: number
  multiplier: number
  balanceRatioCap: number
  riskPercent: number
  slDistancePoints: number
  spec: SymbolSpec
  maxLotLimit: number
}

export type CalcVolumeResult =
  | { ok: true; volume: number; notes?: string }
  | { ok: false; code: string; reason: string }

// ---------- small numeric helpers ----------

export function round2(v: number): number {
  return Math.round(v * 100) / 100
}

export function roundPrice(v: number, digits: number): number {
  const f = Math.pow(10, digits)
  return Math.round(v * f) / f
}

/** Floor a volume to a multiple of the broker volume step (2dp safe). */
export function floorToVolumeStep(v: number, step: number): number {
  const s = step > 0 ? step : 0.01
  return round2(Math.floor(v / s + 1e-9) * s)
}

// ---------- csv / symbol mapping ----------

/** "XAUUSD, EURUSD" -> ["XAUUSD","EURUSD"] (trimmed, uppercased, empty removed). */
export function parseCsvList(s: string): string[] {
  if (!s) return []
  return s
    .split(',')
    .map((x) => x.trim().toUpperCase())
    .filter((x) => x.length > 0)
}

/** "XAUUSD=GOLD;EURUSD=EURUSD.a" -> { XAUUSD: "GOLD", EURUSD: "EURUSD.A" } */
export function parseSymbolMapping(mapping: string): Record<string, string> {
  const out: Record<string, string> = {}
  if (!mapping) return out
  for (const part of mapping.split(';')) {
    const p = part.trim()
    if (!p) continue
    const i = p.indexOf('=')
    if (i <= 0) continue
    const from = p.slice(0, i).trim().toUpperCase()
    const to = p.slice(i + 1).trim().toUpperCase()
    if (from && to) out[from] = to
  }
  return out
}

/** Map a MASTER symbol to the SLAVE symbol name (identity when unmapped). */
export function mapSymbol(symbol: string, mapping: string | Record<string, string>): string {
  const map = typeof mapping === 'string' ? parseSymbolMapping(mapping) : mapping
  const key = symbol.toUpperCase()
  return map[key] ?? symbol
}

// ---------- volume calculation ----------

export function calcVolume(input: CalcVolumeInput): CalcVolumeResult {
  const {
    mode,
    masterVolume,
    masterBalance,
    slaveEquity,
    fixedLot,
    multiplier,
    balanceRatioCap,
    riskPercent,
    slDistancePoints,
    spec,
    maxLotLimit,
  } = input

  if (!spec || !(spec.volumeStep > 0) || !(spec.volumeMin > 0)) {
    return { ok: false, code: 'invalid_symbol_spec', reason: 'Invalid symbol specification on slave terminal' }
  }

  let raw = 0
  let notes: string | undefined

  switch (mode) {
    case 'same':
      raw = masterVolume
      break
    case 'fixed':
      raw = fixedLot
      break
    case 'multiplier':
      raw = masterVolume * (multiplier > 0 ? multiplier : 1)
      break
    case 'balance': {
      if (!(masterBalance > 0)) {
        raw = masterVolume
        notes = 'Master balance unavailable, used same volume'
        break
      }
      const cap = balanceRatioCap > 0 ? balanceRatioCap : 5
      let ratio = slaveEquity / masterBalance
      if (ratio > cap) {
        ratio = cap
        notes = `Equity ratio capped at ${cap}`
      } else if (ratio < 1 / cap) {
        ratio = 1 / cap
        notes = `Equity ratio floored at ${round2(1 / cap)}`
      }
      raw = masterVolume * ratio
      break
    }
    case 'risk': {
      if (slDistancePoints > 0 && riskPercent > 0) {
        const targetRisk = (slaveEquity * riskPercent) / 100
        // Money per 1.0 unit of price movement per 1.0 lot.
        const valuePerPriceUnitPerLot = spec.tickValue / spec.tickSize
        const slDistancePrice = slDistancePoints * spec.point
        const denom = slDistancePrice * valuePerPriceUnitPerLot
        if (denom > 0) {
          raw = targetRisk / denom
        } else {
          raw = masterVolume
          notes = 'Invalid tick value/size, used same volume'
        }
      } else {
        raw = masterVolume
        notes =
          slDistancePoints <= 0
            ? 'No master SL distance, used same volume'
            : 'Invalid risk percent, used same volume'
      }
      break
    }
    default:
      raw = masterVolume
      break
  }

  if (!(raw > 0)) {
    if (masterVolume > 0) {
      return {
        ok: false,
        code: 'invalid_volume',
        reason: 'Calculated volume is zero while master volume is positive',
      }
    }
    return { ok: false, code: 'invalid_volume', reason: 'Calculated volume is zero' }
  }

  // Normalization (applies to ALL modes): floor to step, clamp to
  // [volumeMin, min(volumeMax, maxLotLimit)].
  let vol = floorToVolumeStep(raw, spec.volumeStep)
  const upper = Math.min(spec.volumeMax, maxLotLimit > 0 ? maxLotLimit : spec.volumeMax)
  if (vol > upper) vol = floorToVolumeStep(upper, spec.volumeStep)

  if (vol < spec.volumeMin) {
    return {
      ok: false,
      code: 'invalid_volume',
      reason: `Calculated volume ${round2(raw)} is below broker minimum ${spec.volumeMin} lots`,
    }
  }

  return { ok: true, volume: vol, notes }
}
