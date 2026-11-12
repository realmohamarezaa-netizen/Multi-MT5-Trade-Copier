import { db } from '@/lib/db'
import { readyEngine, ok, fail, errorMessage } from '../_helpers'
import { getSimulator } from '@/lib/simulator'
import type { TerminalRole, TerminalStatus } from '@/lib/types'

export const dynamic = 'force-dynamic'

export async function POST(req: Request) {
  try {
    const engine = await readyEngine()
    const sim = getSimulator()
    const body = (await req.json()) as {
      action: string
      params?: Record<string, unknown>
    }
    const p = body.params ?? {}

    switch (body.action) {
      case 'master_open': {
        const r = await sim.masterOpenTrade({
          symbol: typeof p.symbol === 'string' ? p.symbol : undefined,
          side: p.side === 'buy' || p.side === 'sell' ? p.side : undefined,
          volume: typeof p.volume === 'number' ? p.volume : undefined,
        })
        return ok(r)
      }
      case 'master_close': {
        const r = await sim.masterCloseTrade(typeof p.ticket === 'string' ? p.ticket : undefined)
        return ok(r)
      }
      case 'master_partial': {
        const r = await sim.masterPartialClose(
          typeof p.ticket === 'string' ? p.ticket : undefined,
          typeof p.fraction === 'number' ? p.fraction : 0.5,
        )
        return ok(r)
      }
      case 'master_modify': {
        const r = await sim.masterModifySLTP(typeof p.ticket === 'string' ? p.ticket : undefined)
        return ok(r)
      }
      case 'master_pending': {
        const r = await sim.masterPlacePending({
          symbol: typeof p.symbol === 'string' ? p.symbol : undefined,
          pendingType: typeof p.pendingType === 'string' ? p.pendingType : undefined,
        })
        return ok(r)
      }
      case 'master_cancel_pending': {
        const r = await sim.masterCancelPending(typeof p.ticket === 'string' ? p.ticket : undefined)
        return ok(r)
      }
      case 'set_status': {
        if (typeof p.terminalId !== 'string' || typeof p.status !== 'string') {
          return fail('terminalId and status are required', 422)
        }
        await sim.setTerminalStatus(p.terminalId, p.status as TerminalStatus)
        return ok({ ok: true })
      }
      case 'set_reject': {
        if (typeof p.terminalId !== 'string' || typeof p.value !== 'number') {
          return fail('terminalId and value are required', 422)
        }
        await sim.setRejectProbability(p.terminalId, p.value)
        return ok({ ok: true })
      }
      case 'spread_spike': {
        sim.spreadSpike(typeof p.symbol === 'string' ? p.symbol : undefined)
        return ok({ ok: true })
      }
      case 'add_terminal': {
        const role: TerminalRole = p.role === 'master' ? 'master' : p.role === 'slave' ? 'slave' : 'none'
        const r = await sim.addSimulatedTerminal(role)
        return ok(r, 201)
      }
      case 'remove_terminal': {
        if (typeof p.terminalId !== 'string') return fail('terminalId required', 422)
        await sim.removeSimulatedTerminal(p.terminalId)
        return ok({ ok: true })
      }
      case 'reset': {
        await sim.resetAll()
        await engine.ensureStarted()
        return ok({ ok: true })
      }
      case 'clear_logs': {
        await db.logEntry.deleteMany({})
        return ok({ ok: true })
      }
      default:
        return fail(`Unknown sim action: ${body.action}`, 422)
    }
  } catch (e) {
    return fail(errorMessage(e), 409)
  }
}
