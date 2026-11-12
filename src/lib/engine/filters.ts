// ============================================================
// Copy permission filter chain.
// Pure decision function - no I/O, no side effects.
// The global copyEnabled switch is enforced by the CALLER.
// ============================================================

import type { SlaveSettingsDTO, SymbolSpec, TerminalDTO } from '@/lib/types'
import { parseCsvList } from './lotcalc'

export type FilterResult = { allowed: true } | { allowed: false; code: string; reason: string }

export type FilterSlaveView = Pick<TerminalDTO, 'role' | 'enabled' | 'paused' | 'status'>

export function checkCopyAllowed(input: {
  slave: FilterSlaveView
  settings: SlaveSettingsDTO
  symbol: string
  side: 'buy' | 'sell'
  kind: 'position' | 'pending'
  spec: SymbolSpec | null
  openPositionsCount: number
}): FilterResult {
  const { slave, settings, symbol, side, kind, spec, openPositionsCount } = input

  if (slave.role !== 'slave') {
    return { allowed: false, code: 'role', reason: 'Terminal is not a slave' }
  }
  if (!slave.enabled) {
    return { allowed: false, code: 'disabled', reason: 'Slave copying is disabled' }
  }
  if (slave.paused) {
    return { allowed: false, code: 'paused', reason: 'Slave is paused' }
  }
  if (slave.status !== 'connected') {
    return { allowed: false, code: 'not_connected', reason: `Slave status is ${slave.status}` }
  }
  if (side === 'buy' && !settings.buyEnabled) {
    return { allowed: false, code: 'buy_disabled', reason: 'Buy copying is disabled for this slave' }
  }
  if (side === 'sell' && !settings.sellEnabled) {
    return { allowed: false, code: 'sell_disabled', reason: 'Sell copying is disabled for this slave' }
  }

  const sym = symbol.toUpperCase()
  const whitelist = parseCsvList(settings.symbolWhitelist)
  if (whitelist.length > 0 && !whitelist.includes(sym)) {
    return { allowed: false, code: 'whitelist', reason: `Symbol ${symbol} is not in the whitelist` }
  }
  const blacklist = parseCsvList(settings.symbolBlacklist)
  if (blacklist.includes(sym)) {
    return { allowed: false, code: 'blacklist', reason: `Symbol ${symbol} is blacklisted` }
  }

  if (spec && spec.spreadPoints > settings.maxSpreadPoints) {
    return {
      allowed: false,
      code: 'spread',
      reason: `Spread ${spec.spreadPoints} > max ${settings.maxSpreadPoints} points`,
    }
  }

  if (kind === 'position' && openPositionsCount >= settings.maxPositions) {
    return {
      allowed: false,
      code: 'max_positions',
      reason: `Max positions reached (${openPositionsCount}/${settings.maxPositions})`,
    }
  }

  if (kind === 'pending' && !settings.copyPending) {
    return { allowed: false, code: 'pending_disabled', reason: 'Pending order copying is disabled' }
  }

  if (!spec) {
    return {
      allowed: false,
      code: 'unknown_symbol',
      reason: `Symbol ${symbol} not found on slave even after mapping`,
    }
  }

  return { allowed: true }
}
