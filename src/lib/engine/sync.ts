// ============================================================
// Drift reconciliation between master and each slave.
// - reconcileSlave: compare ledgers, report drift, optionally
//   auto-heal according to the effective sync policy.
// - reconcileAll: run for every slave on engine start.
//
// Reconciliation NEVER blindly re-opens trades: drift is always
// logged, and auto actions go through the same idempotent copy
// pipeline as live events.
// ============================================================

import { db } from '@/lib/db'
import type { SyncPolicy } from '@/lib/types'
import { logEvent } from './logger'

export interface SyncDriftItem {
  masterTicket: string
  kind: 'missing_on_slave' | 'extra_on_slave'
  detail: string
}

export interface ReconcileResult {
  driftItems: SyncDriftItem[]
}

/**
 * Minimal engine surface required by sync.
 * The real CopierEngine implements this; passing it explicitly
 * avoids circular static imports.
 */
export interface SyncHost {
  getMasterTerminalId(): Promise<string | null>
  copyMissingForSlave(slaveId: string, masterTicket: string): Promise<boolean>
  closeSlaveExtraPosition(slaveId: string, slaveTicket: string): Promise<boolean>
}

async function defaultHost(): Promise<SyncHost | null> {
  try {
    const mod = await import('./index')
    return mod.getEngine()
  } catch {
    return null
  }
}

export async function reconcileSlave(
  slaveId: string,
  hostArg?: SyncHost,
  opts?: { policyOverride?: SyncPolicy | null; trigger?: string },
): Promise<ReconcileResult> {
  const host = hostArg ?? (await defaultHost())
  const driftItems: SyncDriftItem[] = []
  try {
    const slave = await db.terminal.findUnique({ where: { id: slaveId }, include: { slaveSettings: true } })
    if (!slave || slave.role !== 'slave') return { driftItems }

    const masterId = host
      ? await host.getMasterTerminalId()
      : (await db.terminal.findFirst({ where: { role: 'master' } }))?.id ?? null
    if (!masterId) {
      await logEvent({
        level: 'info',
        category: 'sync',
        terminalId: slaveId,
        terminalName: slave.name,
        message: 'Reconcile skipped: no master terminal configured',
      })
      return { driftItems }
    }

    const masterPositions = await db.position.findMany({ where: { terminalId: masterId } })
    const slaveCopies = await db.position.findMany({
      where: { terminalId: slaveId, NOT: { masterTicket: '' } },
    })
    const ops = await db.copyOperation.findMany({ where: { slaveTerminalId: slaveId, status: 'executed' } })

    for (const mp of masterPositions) {
      const copied =
        slaveCopies.some((sp) => sp.masterTicket === mp.ticket && sp.kind === mp.kind) ||
        ops.some((o) => o.masterTicket === mp.ticket)
      if (!copied) {
        driftItems.push({
          masterTicket: mp.ticket,
          kind: 'missing_on_slave',
          detail: `Master ${mp.kind} ${mp.symbol} ${mp.side} ${mp.volume} lots${
            mp.kind === 'pending' ? ` (${mp.pendingType})` : ''
          } has no copy on slave`,
        })
      }
    }

    for (const sp of slaveCopies) {
      if (!masterPositions.some((mp) => mp.ticket === sp.masterTicket)) {
        driftItems.push({
          masterTicket: sp.masterTicket,
          kind: 'extra_on_slave',
          detail: `Slave holds ${sp.kind} ${sp.symbol} ${sp.side} ${sp.volume} lots from master ticket ${sp.masterTicket} which is no longer open on master`,
        })
      }
    }

    const trigger = opts?.trigger ?? 'manual'
    if (driftItems.length === 0) {
      await logEvent({
        level: 'info',
        category: 'sync',
        terminalId: slaveId,
        terminalName: slave.name,
        message: `Reconcile (${trigger}): no drift, ${masterPositions.length} master trade(s) in sync`,
      })
    } else {
      await logEvent({
        level: 'warn',
        category: 'sync',
        terminalId: slaveId,
        terminalName: slave.name,
        message: `Reconcile (${trigger}): ${driftItems.length} drift item(s) detected`,
        details: driftItems.map((d) => `${d.kind}: ${d.detail}`).join(' | '),
      })
    }

    // Effective policy: explicit override (startup uses AppSettings.syncOnStart),
    // otherwise the per-slave setting.
    const policy: SyncPolicy =
      opts?.policyOverride ?? ((slave.slaveSettings?.syncPolicy as SyncPolicy | undefined) ?? 'report')

    if (host && driftItems.length > 0 && policy !== 'report') {
      if (policy === 'autoOpenMissing') {
        const missing = driftItems.filter((d) => d.kind === 'missing_on_slave')
        let opened = 0
        for (const d of missing) {
          try {
            if (await host.copyMissingForSlave(slaveId, d.masterTicket)) opened++
          } catch {
            // per-item errors are logged inside the host pipeline
          }
        }
        if (missing.length > 0) {
          await logEvent({
            level: 'success',
            category: 'sync',
            terminalId: slaveId,
            terminalName: slave.name,
            message: `Sync policy autoOpenMissing: opened ${opened}/${missing.length} missing trade(s)`,
          })
        }
      } else if (policy === 'autoCloseExtra') {
        const extras = slaveCopies.filter((sp) => !masterPositions.some((mp) => mp.ticket === sp.masterTicket))
        let closed = 0
        for (const sp of extras) {
          try {
            if (await host.closeSlaveExtraPosition(slaveId, sp.ticket)) closed++
          } catch {
            // per-item errors are logged inside the host pipeline
          }
        }
        if (extras.length > 0) {
          await logEvent({
            level: 'success',
            category: 'sync',
            terminalId: slaveId,
            terminalName: slave.name,
            message: `Sync policy autoCloseExtra: closed ${closed}/${extras.length} extra trade(s)`,
          })
        }
      }
    }

    return { driftItems }
  } catch (e) {
    await logEvent({
      level: 'error',
      category: 'sync',
      terminalId: slaveId,
      message: 'Reconcile failed',
      details: String(e),
    }).catch(() => undefined)
    return { driftItems }
  }
}

export async function reconcileAll(
  host?: SyncHost,
  opts?: { policyOverride?: SyncPolicy | null },
): Promise<{ totalDrift: number }> {
  const h = host ?? (await defaultHost())
  let totalDrift = 0
  try {
    const slaves = await db.terminal.findMany({ where: { role: 'slave' }, select: { id: true } })
    for (const s of slaves) {
      const r = await reconcileSlave(s.id, h ?? undefined, {
        policyOverride: opts?.policyOverride ?? null,
        trigger: 'start',
      })
      totalDrift += r.driftItems.length
    }
  } catch (e) {
    await logEvent({
      level: 'error',
      category: 'sync',
      message: 'reconcileAll failed',
      details: String(e),
    }).catch(() => undefined)
  }
  return { totalDrift }
}
