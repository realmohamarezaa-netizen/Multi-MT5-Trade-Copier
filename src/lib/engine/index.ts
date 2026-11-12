// ============================================================
// CopierEngine - the core of the Multi-MT5 Trade Copier.
//
// Responsibilities:
//  - terminal registry + roles (exactly one master)
//  - idempotent copy pipeline (CopyOperation ledger, unique per
//    (slave, eventKey) -> no duplicate orders on retries/restarts)
//  - per-slave settings, filters, lot calculation, symbol mapping
//  - real latency measurement (detectedAt/sentAt/ackAt/doneAt)
//  - account mirroring with throttled DB writes
//  - restart recovery: full state reloaded from SQLite, drift
//    reconciliation on start, never duplicates CopyOperations
//
// Ingress (onTradeEvent / onTerminalStatus / onAccountUpdate) is
// called by the simulator here and by a real MQL5+Python bridge
// on Windows - the interfaces are identical.
// ============================================================

import { db } from '@/lib/db'
import type { Prisma } from '@prisma/client'
import type {
  AppSettings as DbAppSettings,
  CopyOperation as DbCopyOperation,
  MetricEvent as DbMetricEvent,
  SlaveSettings,
  Terminal,
} from '@prisma/client'
import type {
  AppSettingsDTO,
  ClosedTradeDTO,
  CopyAction,
  CopyOperationDTO,
  CopyOpStatus,
  EmergencyPolicy,
  EngineStatsDTO,
  LatencyStatsDTO,
  LogDTO,
  LotMode,
  MasterTradeRelationDTO,
  PositionDTO,
  SlaveSettingsDTO,
  SnapshotDTO,
  SymbolSpec,
  TerminalCommand,
  TerminalDTO,
  TerminalLink,
  TerminalRole,
  TerminalStatus,
  TradeEvent,
} from '@/lib/types'
import { logEvent } from './logger'
import { calcVolume, floorToVolumeStep, mapSymbol, round2 } from './lotcalc'
import { checkCopyAllowed } from './filters'
import { reconcileAll, reconcileSlave } from './sync'

type TerminalRow = Terminal & { slaveSettings?: SlaveSettings | null }

interface AccountSample {
  balance: number
  equity: number
  floatingPL: number
  freeMargin: number
  marginLevel: number
  ts: number
}

/** Optional hooks the simulator (or a real bridge manager) registers into the engine. */
export interface EngineConnectionControl {
  connect(id: string): Promise<void> | void
  disconnect(id: string): Promise<void> | void
  terminalAdded?(id: string): Promise<void> | void
  terminalRemoved?(id: string): Promise<void> | void
}

interface OpPatch {
  status?: CopyOpStatus
  slaveTicket?: string
  failCode?: string
  failReason?: string
  sentAt?: number
  ackAt?: number
  doneAt?: number
  latencyMs?: number
  totalMs?: number
}

interface MetricInput {
  ts: number
  slaveTerminalId: string
  masterTicket: string
  action: string
  detectMs?: number
  sendMs?: number
  ackMs?: number
  totalMs: number
  ok: boolean
}

function toSettingsDTO(s: SlaveSettings): SlaveSettingsDTO {
  return {
    terminalId: s.terminalId,
    lotMode: s.lotMode as SlaveSettingsDTO['lotMode'],
    fixedLot: s.fixedLot,
    multiplier: s.multiplier,
    balanceRatioCap: s.balanceRatioCap,
    riskPercent: s.riskPercent,
    copySL: s.copySL,
    copyTP: s.copyTP,
    copyModifications: s.copyModifications,
    copyPartialClose: s.copyPartialClose,
    copyPending: s.copyPending,
    closeOnMasterClose: s.closeOnMasterClose,
    maxSpreadPoints: s.maxSpreadPoints,
    maxLot: s.maxLot,
    maxPositions: s.maxPositions,
    slippagePoints: s.slippagePoints,
    buyEnabled: s.buyEnabled,
    sellEnabled: s.sellEnabled,
    symbolWhitelist: s.symbolWhitelist,
    symbolBlacklist: s.symbolBlacklist,
    symbolMapping: s.symbolMapping,
    syncPolicy: s.syncPolicy as SlaveSettingsDTO['syncPolicy'],
    rejectProbability: s.rejectProbability,
    baseLatencyMs: s.baseLatencyMs,
    jitterMs: s.jitterMs,
  }
}

function toAppSettingsDTO(s: DbAppSettings): AppSettingsDTO {
  return {
    engineRunning: s.engineRunning,
    copyEnabled: s.copyEnabled,
    emergencyPolicy: s.emergencyPolicy as EmergencyPolicy,
    syncOnStart: s.syncOnStart as AppSettingsDTO['syncOnStart'],
    masterAutoTrade: s.masterAutoTrade,
    autoTradeIntervalMs: s.autoTradeIntervalMs,
    defaultRejectProbability: s.defaultRejectProbability,
  }
}

export class CopierEngine {
  private links = new Map<string, TerminalLink>()
  private control: EngineConnectionControl | null = null
  private startPromise: Promise<void> | null = null
  private running = false
  private bootedAt = 0
  private hubBooted = false
  private hubBootPromise: Promise<void> | null = null
  private lastAccountWrite = new Map<string, number>()
  private lastAccount = new Map<string, AccountSample>()
  private lastEventTouch = 0

  // ---------- lifecycle ----------

  isRunning(): boolean {
    return this.running
  }

  async ensureStarted(): Promise<void> {
    if (this.running && this.bootedAt > 0) return
    if (this.startPromise) return this.startPromise
    this.startPromise = this.doStart().finally(() => {
      this.startPromise = null
    })
    return this.startPromise
  }

  async restart(): Promise<void> {
    this.running = false
    this.bootedAt = 0
    await logEvent({ level: 'info', category: 'engine', message: 'Engine restart requested' }).catch(
      () => undefined,
    )
    await this.ensureStarted()
  }

  private async doStart(): Promise<void> {
    const now = Date.now()
    // 1. App settings singleton (creates defaults on first boot).
    const settings = await this.ensureAppSettingsRow()
    // 2. Load terminals; make sure every terminal has settings rows.
    const terminals = await db.terminal.findMany({ include: { slaveSettings: true } })
    for (const t of terminals) {
      if (!t.slaveSettings) await this.ensureSlaveSettingsRow(t.id)
    }
    // 3. Persist running state (survives cold restarts).
    this.running = true
    this.bootedAt = now
    try {
      await db.appSettings.update({ where: { id: 'singleton' }, data: { engineRunning: true, bootedAt: now } })
    } catch {
      // ignore
    }
    await logEvent({
      level: 'info',
      category: 'engine',
      message: `Engine started, ${terminals.length} terminals loaded`,
    })
    // 4. Boot the simulator (registers links). On Windows a real bridge
    //    would register links instead; failure here is not fatal.
    await this.ensureSimulatorBooted()
    // 5. Reconcile every slave using AppSettings.syncOnStart as policy override.
    const policy = (settings.syncOnStart as AppSettingsDTO['syncOnStart']) ?? 'report'
    try {
      const r = await reconcileAll(this, { policyOverride: policy })
      if (r.totalDrift > 0) {
        await logEvent({
          level: 'warn',
          category: 'sync',
          message: `Startup reconcile found ${r.totalDrift} drift item(s) (policy: ${policy})`,
        })
      }
    } catch (e) {
      await logEvent({
        level: 'error',
        category: 'sync',
        message: 'Startup reconcile failed',
        details: String(e),
      }).catch(() => undefined)
    }
  }

  private async ensureSimulatorBooted(): Promise<void> {
    if (this.hubBooted) return
    if (this.hubBootPromise) return this.hubBootPromise
    this.hubBootPromise = (async () => {
      try {
        const mod = await import('@/lib/simulator')
        await mod.getSimulator().ensureStarted(this)
        this.hubBooted = true
      } catch (e) {
        await logEvent({
          level: 'warn',
          category: 'engine',
          message: 'Simulator unavailable, engine running without links',
          details: String(e),
        }).catch(() => undefined)
      }
    })().finally(() => {
      this.hubBootPromise = null
    })
    return this.hubBootPromise
  }

  // ---------- link / control registration ----------

  registerLink(terminalId: string, link: TerminalLink): void {
    this.links.set(terminalId, link)
  }

  unregisterLink(terminalId: string): void {
    this.links.delete(terminalId)
  }

  setConnectionControl(control: EngineConnectionControl): void {
    this.control = control
  }

  // ---------- terminal management ----------

  async addTerminal(input: {
    name: string
    broker?: string
    server?: string
    exePath?: string
    simulated?: boolean
  }): Promise<TerminalDTO> {
    const accountNumber = String(Math.floor(10000000 + Math.random() * 89999999))
    const row = await db.terminal.create({
      data: {
        name: input.name,
        broker: input.broker ?? '',
        server: input.server ?? '',
        exePath: input.exePath ?? '',
        simulated: input.simulated ?? true,
        accountNumber,
        balance: 10000,
        equity: 10000,
        freeMargin: 10000,
      },
    })
    await this.ensureSlaveSettingsRow(row.id)
    await logEvent({
      level: 'success',
      category: 'settings',
      terminalId: row.id,
      terminalName: row.name,
      message: `Terminal added: ${row.name}`,
    })
    if (this.control?.terminalAdded) {
      try {
        await this.control.terminalAdded(row.id)
      } catch (e) {
        await logEvent({
          level: 'warn',
          category: 'connection',
          terminalId: row.id,
          message: 'Simulator attach for new terminal failed',
          details: String(e),
        }).catch(() => undefined)
      }
    }
    const fresh = await db.terminal.findUnique({ where: { id: row.id }, include: { slaveSettings: true } })
    return this.toTerminalDTO(fresh ?? row, { open: 0, pending: 0 })
  }

  async removeTerminal(id: string): Promise<void> {
    const t = await db.terminal.findUnique({ where: { id } })
    if (!t) return
    if (this.control?.terminalRemoved) {
      try {
        await this.control.terminalRemoved(id)
      } catch {
        // ignore
      }
    }
    this.unregisterLink(id)
    await db.terminal.delete({ where: { id } })
    await logEvent({
      level: 'warn',
      category: 'settings',
      terminalId: id,
      terminalName: t.name,
      message: `Terminal removed: ${t.name}`,
    })
  }

  async connectTerminal(id: string): Promise<void> {
    const t = await db.terminal.findUnique({ where: { id } })
    if (!t) throw new Error(`Terminal ${id} not found`)
    await db.terminal.update({ where: { id }, data: { status: 'connecting', lastSeen: Date.now() } })
    await logEvent({
      level: 'info',
      category: 'connection',
      terminalId: id,
      terminalName: t.name,
      message: `Connecting to ${t.name}...`,
    })
    if (this.control) {
      try {
        await this.control.connect(id)
      } catch (e) {
        await logEvent({
          level: 'error',
          category: 'connection',
          terminalId: id,
          terminalName: t.name,
          message: 'Connect failed',
          details: String(e),
        }).catch(() => undefined)
      }
    } else {
      // No connector registered (real bridge not attached): report connected
      // so the UI/state stays consistent; the bridge will drive real status.
      await this.onTerminalStatus(id, 'connected')
    }
  }

  async disconnectTerminal(id: string): Promise<void> {
    const t = await db.terminal.findUnique({ where: { id } })
    if (!t) return
    if (this.control) {
      try {
        await this.control.disconnect(id)
      } catch (e) {
        await logEvent({
          level: 'warn',
          category: 'connection',
          terminalId: id,
          terminalName: t.name,
          message: 'Disconnect control failed',
          details: String(e),
        }).catch(() => undefined)
      }
    } else {
      await this.onTerminalStatus(id, 'disconnected')
    }
  }

  async setRole(id: string, role: TerminalRole): Promise<void> {
    const t = await db.terminal.findUnique({ where: { id } })
    if (!t) throw new Error(`Terminal ${id} not found`)
    if (role === 'master') {
      const prev = await db.terminal.findFirst({ where: { role: 'master', NOT: { id } } })
      if (prev) {
        await db.terminal.update({ where: { id: prev.id }, data: { role: 'slave' } })
        await this.ensureSlaveSettingsRow(prev.id)
        await logEvent({
          level: 'warn',
          category: 'settings',
          terminalId: prev.id,
          terminalName: prev.name,
          message: `${prev.name} demoted to slave (only one master is allowed)`,
        })
      }
    }
    await db.terminal.update({ where: { id }, data: { role } })
    if (role === 'slave') await this.ensureSlaveSettingsRow(id)
    await logEvent({
      level: 'success',
      category: 'settings',
      terminalId: id,
      terminalName: t.name,
      message: `${t.name} role set to ${role}`,
    })
  }

  async setSlaveEnabled(id: string, enabled: boolean): Promise<void> {
    await this.ensureSlaveSettingsRow(id)
    await db.terminal.update({ where: { id }, data: { enabled } })
    await logEvent({
      level: 'info',
      category: 'settings',
      terminalId: id,
      message: `Slave copying ${enabled ? 'enabled' : 'disabled'}`,
    })
  }

  async setSlavePaused(id: string, paused: boolean): Promise<void> {
    await this.ensureSlaveSettingsRow(id)
    await db.terminal.update({ where: { id }, data: { paused } })
    await logEvent({
      level: 'info',
      category: 'settings',
      terminalId: id,
      message: `Slave ${paused ? 'paused' : 'resumed'}`,
    })
  }

  async setAutoReconnect(id: string, v: boolean): Promise<void> {
    await db.terminal.update({ where: { id }, data: { autoReconnect: v } })
    await logEvent({
      level: 'info',
      category: 'settings',
      terminalId: id,
      message: `Auto reconnect ${v ? 'enabled' : 'disabled'}`,
    })
  }

  async updateSlaveSettings(terminalId: string, patch: Partial<SlaveSettingsDTO>): Promise<SlaveSettingsDTO> {
    await this.ensureSlaveSettingsRow(terminalId)
    const data: Partial<SlaveSettings> = {}
    if (patch.lotMode !== undefined) data.lotMode = patch.lotMode
    if (patch.fixedLot !== undefined) data.fixedLot = patch.fixedLot
    if (patch.multiplier !== undefined) data.multiplier = patch.multiplier
    if (patch.balanceRatioCap !== undefined) data.balanceRatioCap = patch.balanceRatioCap
    if (patch.riskPercent !== undefined) data.riskPercent = patch.riskPercent
    if (patch.copySL !== undefined) data.copySL = patch.copySL
    if (patch.copyTP !== undefined) data.copyTP = patch.copyTP
    if (patch.copyModifications !== undefined) data.copyModifications = patch.copyModifications
    if (patch.copyPartialClose !== undefined) data.copyPartialClose = patch.copyPartialClose
    if (patch.copyPending !== undefined) data.copyPending = patch.copyPending
    if (patch.closeOnMasterClose !== undefined) data.closeOnMasterClose = patch.closeOnMasterClose
    if (patch.maxSpreadPoints !== undefined) data.maxSpreadPoints = Math.round(patch.maxSpreadPoints)
    if (patch.maxLot !== undefined) data.maxLot = patch.maxLot
    if (patch.maxPositions !== undefined) data.maxPositions = Math.round(patch.maxPositions)
    if (patch.slippagePoints !== undefined) data.slippagePoints = Math.round(patch.slippagePoints)
    if (patch.buyEnabled !== undefined) data.buyEnabled = patch.buyEnabled
    if (patch.sellEnabled !== undefined) data.sellEnabled = patch.sellEnabled
    if (patch.symbolWhitelist !== undefined) data.symbolWhitelist = patch.symbolWhitelist
    if (patch.symbolBlacklist !== undefined) data.symbolBlacklist = patch.symbolBlacklist
    if (patch.symbolMapping !== undefined) data.symbolMapping = patch.symbolMapping
    if (patch.syncPolicy !== undefined) data.syncPolicy = patch.syncPolicy
    if (patch.rejectProbability !== undefined) data.rejectProbability = patch.rejectProbability
    if (patch.baseLatencyMs !== undefined) data.baseLatencyMs = Math.round(patch.baseLatencyMs)
    if (patch.jitterMs !== undefined) data.jitterMs = Math.round(patch.jitterMs)
    const row = await db.slaveSettings.update({ where: { terminalId }, data })
    await logEvent({
      level: 'success',
      category: 'settings',
      terminalId,
      message: 'Slave settings updated',
      details: Object.keys(data).join(', '),
    })
    return toSettingsDTO(row)
  }

  // ---------- global controls ----------

  async startCopying(): Promise<void> {
    await this.setCopyEnabled(true)
  }

  async stopCopying(): Promise<void> {
    await this.setCopyEnabled(false)
  }

  private async setCopyEnabled(v: boolean): Promise<void> {
    await this.ensureAppSettingsRow()
    await db.appSettings.update({ where: { id: 'singleton' }, data: { copyEnabled: v } })
    await logEvent({
      level: v ? 'success' : 'warn',
      category: 'settings',
      message: v ? 'Copying started' : 'Copying stopped (existing positions are NOT closed)',
    })
  }

  async emergencyStop(): Promise<void> {
    const settings = await this.ensureAppSettingsRow()
    await this.setCopyEnabled(false)
    await logEvent({
      level: 'error',
      category: 'engine',
      message: `EMERGENCY STOP activated (policy: ${settings.emergencyPolicy})`,
    })
    const policy = settings.emergencyPolicy as EmergencyPolicy
    if (policy === 'halt') return

    if (policy === 'halt_close_master' || policy === 'halt_close_all') {
      const master = await db.terminal.findFirst({ where: { role: 'master' } })
      if (master) {
        const link = this.links.get(master.id)
        const positions = await db.position.findMany({ where: { terminalId: master.id, kind: 'position' } })
        let closed = 0
        for (const p of positions) {
          try {
            if (link && link.isConnected()) {
              await link.send({ kind: 'close', ticket: p.ticket, symbol: p.symbol, masterTicket: p.ticket })
              closed++
            }
          } catch (e) {
            await logEvent({
              level: 'error',
              category: 'trade',
              terminalId: master.id,
              terminalName: master.name,
              message: `Emergency close failed for master #${p.ticket}`,
              details: String(e),
            }).catch(() => undefined)
          }
        }
        // Slave copies of master positions are closed by the normal
        // position_closed event pipeline.
        await logEvent({
          level: 'warn',
          category: 'trade',
          terminalId: master.id,
          terminalName: master.name,
          message: `Emergency: sent close for ${closed}/${positions.length} master position(s)`,
        })
      }
    }

    if (policy === 'halt_close_all') {
      const slaves = await db.terminal.findMany({ where: { role: 'slave' } })
      let closed = 0
      for (const s of slaves) {
        const link = this.links.get(s.id)
        if (!link || !link.isConnected()) continue
        const positions = await db.position.findMany({ where: { terminalId: s.id, kind: 'position' } })
        for (const p of positions) {
          try {
            await link.send({ kind: 'close', ticket: p.ticket, symbol: p.symbol, masterTicket: p.masterTicket })
            closed++
          } catch (e) {
            await logEvent({
              level: 'error',
              category: 'trade',
              terminalId: s.id,
              terminalName: s.name,
              message: `Emergency close failed for slave position ${p.ticket}`,
              details: String(e),
            }).catch(() => undefined)
          }
        }
      }
      await logEvent({
        level: 'warn',
        category: 'trade',
        message: `Emergency: sent close for ${closed} slave position(s) (halt_close_all)`,
      })
    }
  }

  async updateAppSettings(patch: Partial<AppSettingsDTO>): Promise<AppSettingsDTO> {
    await this.ensureAppSettingsRow()
    const data: Partial<DbAppSettings> = {}
    if (patch.engineRunning !== undefined) data.engineRunning = patch.engineRunning
    if (patch.copyEnabled !== undefined) data.copyEnabled = patch.copyEnabled
    if (patch.emergencyPolicy !== undefined) data.emergencyPolicy = patch.emergencyPolicy
    if (patch.syncOnStart !== undefined) data.syncOnStart = patch.syncOnStart
    if (patch.masterAutoTrade !== undefined) data.masterAutoTrade = patch.masterAutoTrade
    if (patch.autoTradeIntervalMs !== undefined)
      data.autoTradeIntervalMs = Math.max(1000, Math.round(patch.autoTradeIntervalMs))
    if (patch.defaultRejectProbability !== undefined)
      data.defaultRejectProbability = patch.defaultRejectProbability
    const row = await db.appSettings.update({ where: { id: 'singleton' }, data })
    await logEvent({
      level: 'success',
      category: 'settings',
      message: 'App settings updated',
      details: Object.keys(data).join(', '),
    })
    return toAppSettingsDTO(row)
  }

  // ---------- sync actions ----------

  async getMasterTerminalId(): Promise<string | null> {
    const m = await db.terminal.findFirst({ where: { role: 'master' }, select: { id: true } })
    return m?.id ?? null
  }

  /** Manual confirm action: copy every master trade that is missing on the slave. */
  async syncOpenMissing(slaveId: string): Promise<{ opened: number }> {
    const slave = await db.terminal.findUnique({ where: { id: slaveId } })
    if (!slave || slave.role !== 'slave') return { opened: 0 }
    const masterId = await this.getMasterTerminalId()
    if (!masterId) return { opened: 0 }
    const master = await db.terminal.findUnique({ where: { id: masterId } })
    const masterPositions = await db.position.findMany({ where: { terminalId: masterId } })
    const slaveCopies = await db.position.findMany({
      where: { terminalId: slaveId, NOT: { masterTicket: '' } },
    })
    let opened = 0
    for (const mp of masterPositions) {
      if (slaveCopies.some((sp) => sp.masterTicket === mp.ticket && sp.kind === mp.kind)) continue
      const ok = await this.copyMissingForSlave(slaveId, mp.ticket)
      if (ok) opened++
    }
    await logEvent({
      level: 'success',
      category: 'sync',
      terminalId: slaveId,
      terminalName: slave.name,
      message: `Manual sync: opened ${opened} missing trade(s) on slave`,
      details: master ? `master=${master.name}` : undefined,
    })
    return { opened }
  }

  /** Manual confirm action: close every slave copy whose master position is gone. */
  async syncCloseExtra(slaveId: string): Promise<{ closed: number }> {
    const slave = await db.terminal.findUnique({ where: { id: slaveId } })
    if (!slave || slave.role !== 'slave') return { closed: 0 }
    const masterId = await this.getMasterTerminalId()
    const masterPositions = masterId
      ? await db.position.findMany({ where: { terminalId: masterId } })
      : []
    const slaveCopies = await db.position.findMany({
      where: { terminalId: slaveId, NOT: { masterTicket: '' } },
    })
    let closed = 0
    for (const sp of slaveCopies) {
      if (masterPositions.some((mp) => mp.ticket === sp.masterTicket)) continue
      const ok = await this.closeSlaveExtraPosition(slaveId, sp.ticket)
      if (ok) closed++
    }
    await logEvent({
      level: 'success',
      category: 'sync',
      terminalId: slaveId,
      terminalName: slave.name,
      message: `Manual sync: closed ${closed} extra trade(s) on slave`,
    })
    return { closed }
  }

  /** SyncHost implementation: copy one master trade to one slave (reuse non-executed ops). */
  async copyMissingForSlave(slaveId: string, masterTicket: string): Promise<boolean> {
    try {
      const masterId = await this.getMasterTerminalId()
      if (!masterId) return false
      const master = await db.terminal.findUnique({ where: { id: masterId } })
      if (!master) return false
      const mp = await db.position.findFirst({ where: { terminalId: masterId, ticket: masterTicket } })
      if (!mp) return false
      const slave = await db.terminal.findUnique({ where: { id: slaveId }, include: { slaveSettings: true } })
      if (!slave) return false
      const detectedAt = Date.now()
      if (mp.kind === 'pending') {
        const evt: TradeEvent = {
          type: 'pending_placed',
          ticket: mp.ticket,
          symbol: mp.symbol,
          side: mp.side as 'buy' | 'sell',
          volume: mp.volume,
          price: mp.openPrice,
          sl: mp.sl,
          tp: mp.tp,
          pendingType: mp.pendingType,
          ts: mp.openTime || detectedAt,
        }
        return await this.copyPendingToSlave({
          slave,
          evt,
          masterTerminalId: masterId,
          detectedAt,
          copyEnabled: true,
          source: 'sync',
        })
      }
      const evt: TradeEvent = {
        type: 'position_opened',
        ticket: mp.ticket,
        symbol: mp.symbol,
        side: mp.side as 'buy' | 'sell',
        volume: mp.volume,
        price: mp.openPrice,
        sl: mp.sl,
        tp: mp.tp,
        ts: mp.openTime || detectedAt,
      }
      return await this.copyOpenToSlave({
        slave,
        evt,
        masterTerminalId: masterId,
        masterBalance: master.balance,
        detectedAt,
        copyEnabled: true,
        source: 'sync',
      })
    } catch (e) {
      await logEvent({
        level: 'error',
        category: 'sync',
        terminalId: slaveId,
        message: `Sync open failed for master #${masterTicket}`,
        details: String(e),
      }).catch(() => undefined)
      return false
    }
  }

  /** SyncHost implementation: close a slave position whose master is gone. */
  async closeSlaveExtraPosition(slaveId: string, slaveTicket: string): Promise<boolean> {
    try {
      const slave = await db.terminal.findUnique({ where: { id: slaveId } })
      if (!slave) return false
      const pos = await db.position.findFirst({ where: { terminalId: slaveId, ticket: slaveTicket } })
      if (!pos) return false
      const link = this.links.get(slaveId)
      if (!link || !link.isConnected()) {
        await logEvent({
          level: 'error',
          category: 'sync',
          terminalId: slaveId,
          terminalName: slave.name,
          message: `Sync close failed for slave position ${slaveTicket}: terminal offline`,
        })
        return false
      }
      const detectedAt = Date.now()
      const pair = await this.createOrReuseOp({
        slaveTerminalId: slaveId,
        masterTerminalId: '',
        masterTicket: pos.masterTicket,
        action: 'close',
        eventKey: `syncclose:${slaveTicket}`,
        detectedAt,
        payload: JSON.stringify({ slaveTicket, source: 'sync' }),
      })
      if (!pair) return false
      const sentAt = Date.now()
      await this.finishOp(pair.op.id, { status: 'sent', sentAt })
      const res = await link.send({ kind: 'close', ticket: slaveTicket, symbol: pos.symbol })
      const ackAt = res.at || Date.now()
      const doneAt = Date.now()
      if (res.ok) {
        await this.finishOp(pair.op.id, {
          status: 'executed',
          slaveTicket,
          ackAt,
          doneAt,
          latencyMs: Math.max(0, ackAt - detectedAt),
          totalMs: Math.max(0, doneAt - detectedAt),
          failCode: '',
          failReason: '',
        })
        await this.writeMetric({
          ts: detectedAt,
          slaveTerminalId: slaveId,
          masterTicket: pos.masterTicket,
          action: 'close',
          detectMs: Math.max(0, sentAt - detectedAt),
          sendMs: Math.max(0, ackAt - sentAt),
          ackMs: Math.max(0, doneAt - ackAt),
          totalMs: Math.max(0, doneAt - detectedAt),
          ok: true,
        })
        await logEvent({
          level: 'success',
          category: 'sync',
          terminalId: slaveId,
          terminalName: slave.name,
          message: `Sync: closed extra slave position ${slaveTicket} (${pos.symbol} ${pos.volume} lots)`,
        })
        return true
      }
      await this.finishOp(pair.op.id, {
        status: 'failed',
        failCode: res.code ?? 'broker_reject',
        failReason: res.error ?? 'Broker rejected',
        ackAt,
        doneAt,
        latencyMs: Math.max(0, ackAt - detectedAt),
        totalMs: Math.max(0, doneAt - detectedAt),
      })
      await logEvent({
        level: 'error',
        category: 'sync',
        terminalId: slaveId,
        terminalName: slave.name,
        message: `Sync close failed for slave position ${slaveTicket}: ${res.error ?? 'broker rejected'}`,
      })
      return false
    } catch (e) {
      await logEvent({
        level: 'error',
        category: 'sync',
        terminalId: slaveId,
        message: `Sync close error for slave position ${slaveTicket}`,
        details: String(e),
      }).catch(() => undefined)
      return false
    }
  }

  // ---------- INGRESS: trade events ----------

  async onTradeEvent(terminalId: string, evt: TradeEvent): Promise<void> {
    try {
      const t = await db.terminal.findUnique({ where: { id: terminalId }, include: { slaveSettings: true } })
      if (!t) return
      const isMaster = t.role === 'master'
      switch (evt.type) {
        case 'position_opened':
          if (isMaster) await this.handleMasterPositionOpened(t, evt)
          else await this.handleSlavePositionOpened(t, evt)
          break
        case 'position_closed':
          if (isMaster) await this.handleMasterPositionClosed(t, evt)
          else await this.handleSlavePositionClosed(t, evt)
          break
        case 'partial_closed':
          if (isMaster) await this.handleMasterPartialClosed(t, evt)
          else await this.handleSlavePartialClosed(t, evt)
          break
        case 'sltp_modified':
          if (isMaster) await this.handleMasterSltpModified(t, evt)
          else await this.handleSlaveSltpModified(t, evt)
          break
        case 'pending_placed':
          if (isMaster) await this.handleMasterPendingPlaced(t, evt)
          else await this.handleSlavePendingPlaced(t, evt)
          break
        case 'pending_cancelled':
          if (isMaster) await this.handleMasterPendingCancelled(t, evt)
          else await this.handleSlavePendingCancelled(t, evt)
          break
        case 'pending_filled':
          if (isMaster) await this.handleMasterPendingFilled(t, evt)
          else await this.handleSlavePendingFilled(t, evt)
          break
      }
    } catch (e) {
      await logEvent({
        level: 'error',
        category: 'engine',
        terminalId,
        message: `Trade event ${evt.type} handling failed`,
        details: String(e),
      }).catch(() => undefined)
    }
  }

  // ---------- INGRESS: status + account ----------

  async onTerminalStatus(terminalId: string, status: TerminalStatus): Promise<void> {
    try {
      const t = await db.terminal.findUnique({ where: { id: terminalId } })
      if (!t) return
      const prev = t.status as TerminalStatus
      const now = Date.now()
      const data: { status: string; lastSeen: number; reconnectCount?: number } = { status, lastSeen: now }
      if (status === 'connected' && (prev === 'reconnecting' || prev === 'disconnected' || prev === 'error')) {
        data.reconnectCount = t.reconnectCount + 1
      }
      await db.terminal.update({ where: { id: terminalId }, data })
      const level =
        status === 'connected' ? 'success' : status === 'disconnected' || status === 'error' ? 'error' : 'info'
      await logEvent({
        level,
        category: 'connection',
        terminalId,
        terminalName: t.name,
        message: `${t.name}: ${prev} -> ${status}`,
        details: data.reconnectCount ? `reconnect #${data.reconnectCount}` : undefined,
      })
      if (status === 'connected' && t.role === 'slave') {
        const master = await db.terminal.findFirst({ where: { role: 'master' }, select: { id: true } })
        if (master) {
          void reconcileSlave(terminalId, this, { trigger: 'reconnect' }).catch((e) => {
            void logEvent({
              level: 'error',
              category: 'sync',
              terminalId,
              message: 'Post-reconnect reconcile failed',
              details: String(e),
            })
          })
        }
      }
    } catch (e) {
      await logEvent({
        level: 'error',
        category: 'connection',
        terminalId,
        message: 'Status event handling failed',
        details: String(e),
      }).catch(() => undefined)
    }
  }

  async onAccountUpdate(
    terminalId: string,
    acc: { balance: number; equity: number; floatingPL: number; freeMargin: number; marginLevel: number },
  ): Promise<void> {
    try {
      const now = Date.now()
      this.lastAccount.set(terminalId, { ...acc, ts: now })
      const last = this.lastAccountWrite.get(terminalId) ?? 0
      if (now - last >= 1000) {
        this.lastAccountWrite.set(terminalId, now)
        await this.writeAccount(terminalId, acc, now)
      }
    } catch {
      // never throw from ingress
    }
  }

  private async writeAccount(
    terminalId: string,
    acc: { balance: number; equity: number; floatingPL: number; freeMargin: number; marginLevel: number },
    now: number,
  ): Promise<void> {
    try {
      await db.terminal.update({
        where: { id: terminalId },
        data: {
          balance: round2(acc.balance),
          equity: round2(acc.equity),
          floatingPL: round2(acc.floatingPL),
          freeMargin: round2(acc.freeMargin),
          marginLevel: round2(acc.marginLevel),
          lastSeen: now,
        },
      })
    } catch {
      // ignore
    }
  }

  /** Force-write the latest known account state (used after closes for final values). */
  private flushAccountNow(terminalId: string): void {
    const acc = this.lastAccount.get(terminalId)
    if (!acc) return
    this.lastAccountWrite.set(terminalId, Date.now())
    void this.writeAccount(terminalId, acc, Date.now())
  }

  // ---------- master event pipelines ----------

  private async handleMasterPositionOpened(t: TerminalRow, evt: TradeEvent): Promise<void> {
    const detectedAt = Date.now()
    await this.touchLastEventAt(detectedAt)
    // Master ledger row (the simulator also writes its own; upsert is idempotent).
    await db.position.upsert({
      where: { terminalId_ticket: { terminalId: t.id, ticket: evt.ticket } },
      update: { volume: evt.volume, currentPrice: evt.price ?? 0, sl: evt.sl ?? 0, tp: evt.tp ?? 0 },
      create: {
        terminalId: t.id,
        ticket: evt.ticket,
        symbol: evt.symbol,
        side: evt.side ?? 'buy',
        kind: 'position',
        pendingType: '',
        volume: evt.volume,
        openPrice: evt.price ?? 0,
        currentPrice: evt.price ?? 0,
        sl: evt.sl ?? 0,
        tp: evt.tp ?? 0,
        profit: 0,
        openTime: evt.ts,
        masterTicket: '',
        copiedByEngine: false,
      },
    })
    await logEvent({
      level: 'info',
      category: 'trade',
      terminalId: t.id,
      terminalName: t.name,
      message: `Master opened ${evt.side ?? 'buy'} ${evt.symbol} ${evt.volume} lots @ ${evt.price ?? '-'}`,
      details: `ticket=${evt.ticket}${evt.sl ? ` sl=${evt.sl}` : ''}${evt.tp ? ` tp=${evt.tp}` : ''}`,
    })
    const settings = await this.ensureAppSettingsRow()
    const slaves = await db.terminal.findMany({ where: { role: 'slave' }, include: { slaveSettings: true } })
    await Promise.allSettled(
      slaves.map((s) =>
        this.copyOpenToSlave({
          slave: s,
          evt,
          masterTerminalId: t.id,
          masterBalance: t.balance,
          detectedAt,
          copyEnabled: settings.copyEnabled,
          source: 'event',
        }),
      ),
    )
  }

  private async copyOpenToSlave(o: {
    slave: TerminalRow
    evt: TradeEvent
    masterTerminalId: string
    masterBalance: number
    detectedAt: number
    copyEnabled: boolean
    source: 'event' | 'sync'
  }): Promise<boolean> {
    const { slave, evt, masterTerminalId, masterBalance, detectedAt, copyEnabled, source } = o
    const s = slave.slaveSettings ?? (await this.ensureSlaveSettingsRow(slave.id))
    const eventKey = `open:${evt.ticket}`
    const payload = JSON.stringify({ symbol: evt.symbol, side: evt.side, volume: evt.volume })
    let op: DbCopyOperation | null = null
    if (source === 'event') {
      // Strict idempotency: an existing (slave, eventKey) op means this event
      // was already processed (retry, reconnect or restart) -> skip silently.
      op = await this.tryCreateOp({
        slaveTerminalId: slave.id,
        masterTerminalId,
        masterTicket: evt.ticket,
        action: 'open',
        eventKey,
        detectedAt,
        payload,
      })
      if (!op) return false
    } else {
      const pair = await this.createOrReuseOp({
        slaveTerminalId: slave.id,
        masterTerminalId,
        masterTicket: evt.ticket,
        action: 'open',
        eventKey,
        detectedAt,
        payload,
      })
      if (!pair) return false
      op = pair.op
    }

    const failFast = async (
      status: 'skipped' | 'failed',
      code: string,
      reason: string,
      withMetric: boolean,
    ): Promise<boolean> => {
      const doneAt = Date.now()
      await this.finishOp(op!.id, {
        status,
        failCode: code,
        failReason: reason,
        doneAt,
        ...(status === 'failed' ? { latencyMs: Math.max(0, doneAt - detectedAt), totalMs: Math.max(0, doneAt - detectedAt) } : {}),
      })
      if (withMetric) {
        await this.writeMetric({
          ts: detectedAt,
          slaveTerminalId: slave.id,
          masterTicket: evt.ticket,
          action: 'open',
          totalMs: Math.max(0, doneAt - detectedAt),
          ok: false,
        })
      }
      await logEvent({
        level: status === 'failed' ? 'error' : 'warn',
        category: 'copy',
        terminalId: slave.id,
        terminalName: slave.name,
        message: `Copy ${status} for master #${evt.ticket} ${evt.symbol}: ${reason}`,
        details: `code=${code}`,
      })
      return false
    }

    try {
      if (!copyEnabled) return await failFast('skipped', 'copy_disabled', 'Global copying is stopped', false)

      const mapped = mapSymbol(evt.symbol, s.symbolMapping)
      const link = this.links.get(slave.id) ?? null
      const spec = link ? link.getSymbolSpec(mapped) : null
      const openPositionsCount = await db.position.count({
        where: { terminalId: slave.id, kind: 'position' },
      })
      const guard = checkCopyAllowed({
        slave: {
          role: 'slave',
          enabled: slave.enabled,
          paused: slave.paused,
          status: slave.status as TerminalStatus,
        },
        settings: toSettingsDTO(s),
        symbol: evt.symbol,
        side: evt.side ?? 'buy',
        kind: 'position',
        spec,
        openPositionsCount,
      })
      if (!guard.allowed) return await failFast('skipped', guard.code, guard.reason, false)
      if (!spec) {
        return await failFast('failed', 'unknown_symbol', `Symbol ${mapped} not found on slave terminal`, true)
      }

      const slDistancePoints =
        evt.sl && evt.price ? Math.abs(evt.price - evt.sl) / (spec.point || 1) : 0
      const lot = calcVolume({
        mode: s.lotMode as LotMode,
        masterVolume: evt.volume ?? 0,
        masterBalance,
        slaveEquity: slave.equity,
        fixedLot: s.fixedLot,
        multiplier: s.multiplier,
        balanceRatioCap: s.balanceRatioCap,
        riskPercent: s.riskPercent,
        slDistancePoints,
        spec,
        maxLotLimit: s.maxLot,
      })
      if (!lot.ok) return await failFast('failed', lot.code, lot.reason, true)
      if (!link || !link.isConnected()) {
        return await failFast('failed', 'offline', 'Slave terminal is not connected', true)
      }

      const sentAt = Date.now()
      await this.finishOp(op.id, { status: 'sent', sentAt })
      const cmd: TerminalCommand = {
        kind: 'open',
        symbol: mapped,
        side: evt.side ?? 'buy',
        volume: lot.volume,
        sl: s.copySL ? evt.sl ?? 0 : 0,
        tp: s.copyTP ? evt.tp ?? 0 : 0,
        masterTicket: evt.ticket,
        eventKey,
      }
      const res = await link.send(cmd)
      const ackAt = res.at || Date.now()
      const doneAt = Date.now()
      if (res.ok && res.ticket) {
        await this.finishOp(op.id, {
          status: 'executed',
          slaveTicket: res.ticket,
          ackAt,
          doneAt,
          latencyMs: Math.max(0, ackAt - detectedAt),
          totalMs: Math.max(0, doneAt - detectedAt),
          failCode: '',
          failReason: '',
        })
        await db.position.upsert({
          where: { terminalId_ticket: { terminalId: slave.id, ticket: res.ticket } },
          update: { masterTicket: evt.ticket, copiedByEngine: true },
          create: {
            terminalId: slave.id,
            ticket: res.ticket,
            symbol: mapped,
            side: evt.side ?? 'buy',
            kind: 'position',
            pendingType: '',
            volume: lot.volume,
            openPrice: res.price ?? evt.price ?? 0,
            currentPrice: evt.price ?? res.price ?? 0,
            sl: cmd.sl ?? 0,
            tp: cmd.tp ?? 0,
            profit: 0,
            openTime: doneAt,
            masterTicket: evt.ticket,
            copiedByEngine: true,
          },
        })
        await this.writeMetric({
          ts: detectedAt,
          slaveTerminalId: slave.id,
          masterTicket: evt.ticket,
          action: 'open',
          detectMs: Math.max(0, sentAt - detectedAt),
          sendMs: Math.max(0, ackAt - sentAt),
          ackMs: Math.max(0, doneAt - ackAt),
          totalMs: Math.max(0, doneAt - detectedAt),
          ok: true,
        })
        await logEvent({
          level: 'success',
          category: 'copy',
          terminalId: slave.id,
          terminalName: slave.name,
          message: `Copied master #${evt.ticket} ${evt.side ?? 'buy'} ${evt.symbol} -> ${mapped} ${lot.volume} lots`,
          details: `slaveTicket=${res.ticket} price=${res.price ?? '-'}${
            lot.notes ? ` note=${lot.notes}` : ''
          } latency=${ackAt - detectedAt}ms total=${doneAt - detectedAt}ms`,
        })
        return true
      }
      return await failFast('failed', res.code ?? 'broker_reject', res.error ?? 'Broker rejected the order', true)
    } catch (e) {
      try {
        await this.finishOp(op.id, {
          status: 'failed',
          failCode: 'engine_error',
          failReason: String(e),
          doneAt: Date.now(),
        })
      } catch {
        // ignore
      }
      await logEvent({
        level: 'error',
        category: 'copy',
        terminalId: slave.id,
        terminalName: slave.name,
        message: `Copy pipeline error for master #${evt.ticket}`,
        details: String(e),
      }).catch(() => undefined)
      return false
    }
  }

  private async handleMasterPositionClosed(t: TerminalRow, evt: TradeEvent): Promise<void> {
    const detectedAt = Date.now()
    await this.touchLastEventAt(detectedAt)
    // Move master Position -> ClosedTrade (simulator already did too; idempotent upsert).
    const existing = await db.position.findUnique({
      where: { terminalId_ticket: { terminalId: t.id, ticket: evt.ticket } },
    })
    if (existing) {
      const spec = this.links.get(t.id)?.getSymbolSpec(evt.symbol) ?? null
      const closePrice = evt.price ?? existing.currentPrice
      const profit = this.estimateProfit(
        existing.symbol,
        existing.side as 'buy' | 'sell',
        existing.volume,
        existing.openPrice,
        closePrice,
        spec,
      )
      const closeReason = evt.closeReason ?? 'engine'
      await db.closedTrade.upsert({
        where: { terminalId_ticket: { terminalId: t.id, ticket: evt.ticket } },
        update: { closePrice, closeReason, profit, closeTime: evt.ts },
        create: {
          terminalId: t.id,
          ticket: existing.ticket,
          symbol: existing.symbol,
          side: existing.side,
          kind: existing.kind,
          pendingType: existing.pendingType,
          volume: existing.volume,
          openPrice: existing.openPrice,
          closePrice,
          sl: existing.sl,
          tp: existing.tp,
          profit,
          openTime: existing.openTime,
          closeTime: evt.ts,
          closeReason,
          masterTicket: existing.masterTicket,
        },
      })
      await db.position.delete({ where: { id: existing.id } }).catch(() => undefined)
    }
    await logEvent({
      level: 'info',
      category: 'trade',
      terminalId: t.id,
      terminalName: t.name,
      message: `Master closed #${evt.ticket} ${evt.symbol} (${evt.closeReason ?? 'engine'}) @ ${evt.price ?? '-'}`,
    })
    const slaves = await db.terminal.findMany({ where: { role: 'slave' }, include: { slaveSettings: true } })
    await Promise.allSettled(slaves.map((s) => this.closeOnSlave(s, evt, t.id, detectedAt)))
  }

  private async closeOnSlave(
    slave: TerminalRow,
    evt: TradeEvent,
    masterTerminalId: string,
    detectedAt: number,
  ): Promise<boolean> {
    const s = slave.slaveSettings ?? (await this.ensureSlaveSettingsRow(slave.id))
    const slavePos = await db.position.findFirst({
      where: { terminalId: slave.id, masterTicket: evt.ticket },
    })
    const openOp = await db.copyOperation.findFirst({
      where: { slaveTerminalId: slave.id, masterTicket: evt.ticket, action: 'open', status: 'executed' },
    })
    const slaveTicket = slavePos?.ticket ?? openOp?.slaveTicket ?? ''
    const eventKey = `close:${evt.ticket}:${slaveTicket || 'none'}`
    const op = await this.tryCreateOp({
      slaveTerminalId: slave.id,
      masterTerminalId,
      masterTicket: evt.ticket,
      action: 'close',
      eventKey,
      detectedAt,
      payload: JSON.stringify({ slaveTicket }),
    })
    if (!op) return false

    const failOrMiss = async (status: 'skipped' | 'failed' | 'missed', code: string, reason: string) => {
      await this.finishOp(op!.id, { status, failCode: code, failReason: reason, doneAt: Date.now() })
      await logEvent({
        level: status === 'missed' || status === 'skipped' ? 'warn' : 'error',
        category: 'copy',
        terminalId: slave.id,
        terminalName: slave.name,
        message: `Close copy for master #${evt.ticket}: ${reason}`,
        details: `status=${status} code=${code}`,
      })
      return false
    }

    try {
      if (!slaveTicket) {
        return await failOrMiss('missed', 'no_position', 'No copied position found on slave for this master ticket')
      }
      if (!s.closeOnMasterClose) {
        return await failOrMiss(
          'skipped',
          'close_disabled',
          `closeOnMasterClose is disabled; slave position ${slaveTicket} kept open`,
        )
      }
      const link = this.links.get(slave.id) ?? null
      if (!link || !link.isConnected()) {
        await this.finishOp(op.id, { status: 'failed', failCode: 'offline', failReason: 'Slave terminal is not connected', doneAt: Date.now() })
        await this.writeMetric({
          ts: detectedAt,
          slaveTerminalId: slave.id,
          masterTicket: evt.ticket,
          action: 'close',
          totalMs: Math.max(0, Date.now() - detectedAt),
          ok: false,
        })
        await logEvent({
          level: 'error',
          category: 'copy',
          terminalId: slave.id,
          terminalName: slave.name,
          message: `Close copy failed for master #${evt.ticket}: slave offline`,
        })
        return false
      }
      const sentAt = Date.now()
      await this.finishOp(op.id, { status: 'sent', sentAt })
      const res = await link.send({
        kind: 'close',
        ticket: slaveTicket,
        symbol: slavePos?.symbol ?? mapSymbol(evt.symbol, s.symbolMapping),
      })
      const ackAt = res.at || Date.now()
      const doneAt = Date.now()
      if (res.ok) {
        await this.finishOp(op.id, {
          status: 'executed',
          slaveTicket,
          ackAt,
          doneAt,
          latencyMs: Math.max(0, ackAt - detectedAt),
          totalMs: Math.max(0, doneAt - detectedAt),
          failCode: '',
          failReason: '',
        })
        await this.writeMetric({
          ts: detectedAt,
          slaveTerminalId: slave.id,
          masterTicket: evt.ticket,
          action: 'close',
          detectMs: Math.max(0, sentAt - detectedAt),
          sendMs: Math.max(0, ackAt - sentAt),
          ackMs: Math.max(0, doneAt - ackAt),
          totalMs: Math.max(0, doneAt - detectedAt),
          ok: true,
        })
        await logEvent({
          level: 'success',
          category: 'copy',
          terminalId: slave.id,
          terminalName: slave.name,
          message: `Closed slave position ${slaveTicket} following master #${evt.ticket}`,
          details: `closePrice=${res.price ?? evt.price ?? '-'} total=${doneAt - detectedAt}ms`,
        })
        return true
      }
      await this.finishOp(op.id, {
        status: 'failed',
        failCode: res.code ?? 'broker_reject',
        failReason: res.error ?? 'Broker rejected',
        ackAt,
        doneAt,
        latencyMs: Math.max(0, ackAt - detectedAt),
        totalMs: Math.max(0, doneAt - detectedAt),
      })
      await this.writeMetric({
        ts: detectedAt,
        slaveTerminalId: slave.id,
        masterTicket: evt.ticket,
        action: 'close',
        totalMs: Math.max(0, doneAt - detectedAt),
        ok: false,
      })
      await logEvent({
        level: 'error',
        category: 'copy',
        terminalId: slave.id,
        terminalName: slave.name,
        message: `Close copy failed for master #${evt.ticket}: ${res.error ?? 'broker rejected'}`,
        details: `code=${res.code ?? 'broker_reject'}`,
      })
      return false
    } catch (e) {
      try {
        await this.finishOp(op.id, { status: 'failed', failCode: 'engine_error', failReason: String(e), doneAt: Date.now() })
      } catch {
        // ignore
      }
      await logEvent({
        level: 'error',
        category: 'copy',
        terminalId: slave.id,
        terminalName: slave.name,
        message: `Close copy pipeline error for master #${evt.ticket}`,
        details: String(e),
      }).catch(() => undefined)
      return false
    }
  }

  private async handleMasterPartialClosed(t: TerminalRow, evt: TradeEvent): Promise<void> {
    const detectedAt = Date.now()
    await this.touchLastEventAt(detectedAt)
    const preVolume = (evt.volume ?? 0) + (evt.closedVolume ?? 0)
    await db.position.updateMany({
      where: { terminalId: t.id, ticket: evt.ticket },
      data: { volume: evt.volume ?? 0, currentPrice: evt.price ?? 0 },
    })
    await logEvent({
      level: 'info',
      category: 'trade',
      terminalId: t.id,
      terminalName: t.name,
      message: `Master partial close #${evt.ticket}: closed ${evt.closedVolume ?? 0} of ${preVolume} lots`,
    })
    const slaves = await db.terminal.findMany({ where: { role: 'slave' }, include: { slaveSettings: true } })
    await Promise.allSettled(
      slaves.map((s) => this.partialOnSlave(s, evt, t.id, detectedAt, preVolume)),
    )
  }

  private async partialOnSlave(
    slave: TerminalRow,
    evt: TradeEvent,
    masterTerminalId: string,
    detectedAt: number,
    preVolume: number,
  ): Promise<boolean> {
    const s = slave.slaveSettings ?? (await this.ensureSlaveSettingsRow(slave.id))
    const eventKey = `partial:${evt.ticket}:${evt.ts}`
    const op = await this.tryCreateOp({
      slaveTerminalId: slave.id,
      masterTerminalId,
      masterTicket: evt.ticket,
      action: 'partial',
      eventKey,
      detectedAt,
      payload: JSON.stringify({ closedVolume: evt.closedVolume, masterPreVolume: preVolume }),
    })
    if (!op) return false
    try {
      if (!s.copyPartialClose) {
        await this.finishOp(op.id, {
          status: 'skipped',
          failCode: 'partial_disabled',
          failReason: 'copyPartialClose is disabled for this slave',
          doneAt: Date.now(),
        })
        await logEvent({
          level: 'warn',
          category: 'copy',
          terminalId: slave.id,
          terminalName: slave.name,
          message: `Partial close skipped for master #${evt.ticket}: copyPartialClose disabled`,
        })
        return false
      }
      const slavePos = await db.position.findFirst({
        where: { terminalId: slave.id, masterTicket: evt.ticket, kind: 'position' },
      })
      if (!slavePos) {
        await this.finishOp(op.id, {
          status: 'missed',
          failCode: 'no_position',
          failReason: 'No copied position found on slave for this master ticket',
          doneAt: Date.now(),
        })
        await logEvent({
          level: 'warn',
          category: 'copy',
          terminalId: slave.id,
          terminalName: slave.name,
          message: `Partial close missed for master #${evt.ticket}: no copied position on slave`,
        })
        return false
      }
      const link = this.links.get(slave.id) ?? null
      if (!link || !link.isConnected()) {
        await this.finishOp(op.id, { status: 'failed', failCode: 'offline', failReason: 'Slave terminal is not connected', doneAt: Date.now() })
        await this.writeMetric({
          ts: detectedAt,
          slaveTerminalId: slave.id,
          masterTicket: evt.ticket,
          action: 'partial',
          totalMs: Math.max(0, Date.now() - detectedAt),
          ok: false,
        })
        await logEvent({
          level: 'error',
          category: 'copy',
          terminalId: slave.id,
          terminalName: slave.name,
          message: `Partial close failed for master #${evt.ticket}: slave offline`,
        })
        return false
      }
      // Scale closed volume by slave/master original volume ratio.
      const fraction = preVolume > 0 ? (evt.closedVolume ?? 0) / preVolume : 0
      const spec = link.getSymbolSpec(slavePos.symbol)
      const step = spec?.volumeStep ?? 0.01
      const vmin = spec?.volumeMin ?? 0.01
      let closeVol = floorToVolumeStep(slavePos.volume * fraction, step)
      let fullClose = false
      if (closeVol <= 0 || slavePos.volume - closeVol < vmin) {
        fullClose = true
        closeVol = slavePos.volume
      }
      const sentAt = Date.now()
      await this.finishOp(op.id, { status: 'sent', sentAt })
      const res = await link.send(
        fullClose
          ? { kind: 'close', ticket: slavePos.ticket, symbol: slavePos.symbol }
          : { kind: 'partial', ticket: slavePos.ticket, symbol: slavePos.symbol, volume: closeVol },
      )
      const ackAt = res.at || Date.now()
      const doneAt = Date.now()
      if (res.ok) {
        await this.finishOp(op.id, {
          status: 'executed',
          slaveTicket: slavePos.ticket,
          ackAt,
          doneAt,
          latencyMs: Math.max(0, ackAt - detectedAt),
          totalMs: Math.max(0, doneAt - detectedAt),
          failCode: '',
          failReason: '',
        })
        await this.writeMetric({
          ts: detectedAt,
          slaveTerminalId: slave.id,
          masterTicket: evt.ticket,
          action: 'partial',
          detectMs: Math.max(0, sentAt - detectedAt),
          sendMs: Math.max(0, ackAt - sentAt),
          ackMs: Math.max(0, doneAt - ackAt),
          totalMs: Math.max(0, doneAt - detectedAt),
          ok: true,
        })
        await logEvent({
          level: 'success',
          category: 'copy',
          terminalId: slave.id,
          terminalName: slave.name,
          message: `Partial closed ${closeVol} lots of slave position ${slavePos.ticket} (master #${evt.ticket})${
            fullClose ? ' - slave fully closed (remaining below broker minimum)' : ''
          }`,
        })
        return true
      }
      await this.finishOp(op.id, {
        status: 'failed',
        failCode: res.code ?? 'broker_reject',
        failReason: res.error ?? 'Broker rejected',
        ackAt,
        doneAt,
        latencyMs: Math.max(0, ackAt - detectedAt),
        totalMs: Math.max(0, doneAt - detectedAt),
      })
      await this.writeMetric({
        ts: detectedAt,
        slaveTerminalId: slave.id,
        masterTicket: evt.ticket,
        action: 'partial',
        totalMs: Math.max(0, doneAt - detectedAt),
        ok: false,
      })
      await logEvent({
        level: 'error',
        category: 'copy',
        terminalId: slave.id,
        terminalName: slave.name,
        message: `Partial close failed for master #${evt.ticket}: ${res.error ?? 'broker rejected'}`,
      })
      return false
    } catch (e) {
      try {
        await this.finishOp(op.id, { status: 'failed', failCode: 'engine_error', failReason: String(e), doneAt: Date.now() })
      } catch {
        // ignore
      }
      await logEvent({
        level: 'error',
        category: 'copy',
        terminalId: slave.id,
        terminalName: slave.name,
        message: `Partial close pipeline error for master #${evt.ticket}`,
        details: String(e),
      }).catch(() => undefined)
      return false
    }
  }

  private async handleMasterSltpModified(t: TerminalRow, evt: TradeEvent): Promise<void> {
    const detectedAt = Date.now()
    await this.touchLastEventAt(detectedAt)
    await db.position.updateMany({
      where: { terminalId: t.id, ticket: evt.ticket },
      data: { sl: evt.sl ?? 0, tp: evt.tp ?? 0 },
    })
    await logEvent({
      level: 'info',
      category: 'trade',
      terminalId: t.id,
      terminalName: t.name,
      message: `Master modified SL/TP #${evt.ticket}: sl=${evt.sl ?? 0} tp=${evt.tp ?? 0}`,
    })
    const slaves = await db.terminal.findMany({ where: { role: 'slave' }, include: { slaveSettings: true } })
    await Promise.allSettled(slaves.map((s) => this.modifyOnSlave(s, evt, t.id, detectedAt)))
  }

  private async modifyOnSlave(
    slave: TerminalRow,
    evt: TradeEvent,
    masterTerminalId: string,
    detectedAt: number,
  ): Promise<boolean> {
    const s = slave.slaveSettings ?? (await this.ensureSlaveSettingsRow(slave.id))
    const eventKey = `modify:${evt.ticket}:${evt.ts}`
    const op = await this.tryCreateOp({
      slaveTerminalId: slave.id,
      masterTerminalId,
      masterTicket: evt.ticket,
      action: 'modify_sltp',
      eventKey,
      detectedAt,
      payload: JSON.stringify({ sl: evt.sl, tp: evt.tp }),
    })
    if (!op) return false
    try {
      if (!s.copyModifications) {
        await this.finishOp(op.id, {
          status: 'skipped',
          failCode: 'modify_disabled',
          failReason: 'copyModifications is disabled for this slave',
          doneAt: Date.now(),
        })
        return false
      }
      const slavePos = await db.position.findFirst({ where: { terminalId: slave.id, masterTicket: evt.ticket } })
      if (!slavePos) {
        await this.finishOp(op.id, {
          status: 'missed',
          failCode: 'no_position',
          failReason: 'No copied position found on slave for this master ticket',
          doneAt: Date.now(),
        })
        return false
      }
      const link = this.links.get(slave.id) ?? null
      if (!link || !link.isConnected()) {
        await this.finishOp(op.id, { status: 'failed', failCode: 'offline', failReason: 'Slave terminal is not connected', doneAt: Date.now() })
        return false
      }
      const sentAt = Date.now()
      await this.finishOp(op.id, { status: 'sent', sentAt })
      const res = await link.send({
        kind: 'modify_sltp',
        ticket: slavePos.ticket,
        symbol: slavePos.symbol,
        sl: s.copySL ? evt.sl ?? 0 : 0,
        tp: s.copyTP ? evt.tp ?? 0 : 0,
      })
      const ackAt = res.at || Date.now()
      const doneAt = Date.now()
      if (res.ok) {
        await this.finishOp(op.id, {
          status: 'executed',
          slaveTicket: slavePos.ticket,
          ackAt,
          doneAt,
          latencyMs: Math.max(0, ackAt - detectedAt),
          totalMs: Math.max(0, doneAt - detectedAt),
          failCode: '',
          failReason: '',
        })
        await db.position.updateMany({
          where: { terminalId: slave.id, ticket: slavePos.ticket },
          data: { sl: s.copySL ? evt.sl ?? 0 : 0, tp: s.copyTP ? evt.tp ?? 0 : 0 },
        })
        await logEvent({
          level: 'success',
          category: 'copy',
          terminalId: slave.id,
          terminalName: slave.name,
          message: `Modified SL/TP of slave position ${slavePos.ticket} (master #${evt.ticket})`,
          details: `sl=${s.copySL ? evt.sl ?? 0 : 0} tp=${s.copyTP ? evt.tp ?? 0 : 0}`,
        })
        return true
      }
      await this.finishOp(op.id, {
        status: 'failed',
        failCode: res.code ?? 'broker_reject',
        failReason: res.error ?? 'Broker rejected',
        ackAt,
        doneAt,
        latencyMs: Math.max(0, ackAt - detectedAt),
        totalMs: Math.max(0, doneAt - detectedAt),
      })
      return false
    } catch (e) {
      try {
        await this.finishOp(op.id, { status: 'failed', failCode: 'engine_error', failReason: String(e), doneAt: Date.now() })
      } catch {
        // ignore
      }
      await logEvent({
        level: 'error',
        category: 'copy',
        terminalId: slave.id,
        terminalName: slave.name,
        message: `Modify pipeline error for master #${evt.ticket}`,
        details: String(e),
      }).catch(() => undefined)
      return false
    }
  }

  private async handleMasterPendingPlaced(t: TerminalRow, evt: TradeEvent): Promise<void> {
    const detectedAt = Date.now()
    await this.touchLastEventAt(detectedAt)
    await db.position.upsert({
      where: { terminalId_ticket: { terminalId: t.id, ticket: evt.ticket } },
      update: {
        kind: 'pending',
        pendingType: evt.pendingType ?? '',
        volume: evt.volume,
        openPrice: evt.price ?? 0,
        currentPrice: evt.price ?? 0,
        sl: evt.sl ?? 0,
        tp: evt.tp ?? 0,
      },
      create: {
        terminalId: t.id,
        ticket: evt.ticket,
        symbol: evt.symbol,
        side: evt.side ?? 'buy',
        kind: 'pending',
        pendingType: evt.pendingType ?? '',
        volume: evt.volume,
        openPrice: evt.price ?? 0,
        currentPrice: evt.price ?? 0,
        sl: evt.sl ?? 0,
        tp: evt.tp ?? 0,
        profit: 0,
        openTime: evt.ts,
        masterTicket: '',
        copiedByEngine: false,
      },
    })
    await logEvent({
      level: 'info',
      category: 'trade',
      terminalId: t.id,
      terminalName: t.name,
      message: `Master placed ${evt.pendingType ?? 'pending'} ${evt.symbol} ${evt.volume} lots @ ${evt.price ?? '-'}`,
      details: `ticket=${evt.ticket}`,
    })
    const settings = await this.ensureAppSettingsRow()
    const slaves = await db.terminal.findMany({ where: { role: 'slave' }, include: { slaveSettings: true } })
    await Promise.allSettled(
      slaves.map((s) =>
        this.copyPendingToSlave({
          slave: s,
          evt,
          masterTerminalId: t.id,
          detectedAt,
          copyEnabled: settings.copyEnabled,
          source: 'event',
        }),
      ),
    )
  }

  private async copyPendingToSlave(o: {
    slave: TerminalRow
    evt: TradeEvent
    masterTerminalId: string
    detectedAt: number
    copyEnabled: boolean
    source: 'event' | 'sync'
  }): Promise<boolean> {
    const { slave, evt, masterTerminalId, detectedAt, copyEnabled, source } = o
    const s = slave.slaveSettings ?? (await this.ensureSlaveSettingsRow(slave.id))
    const eventKey = `popen:${evt.ticket}`
    const payload = JSON.stringify({
      symbol: evt.symbol,
      side: evt.side,
      volume: evt.volume,
      pendingType: evt.pendingType,
      price: evt.price,
    })
    let op: DbCopyOperation | null = null
    if (source === 'event') {
      op = await this.tryCreateOp({
        slaveTerminalId: slave.id,
        masterTerminalId,
        masterTicket: evt.ticket,
        action: 'place_pending',
        eventKey,
        detectedAt,
        payload,
      })
      if (!op) return false
    } else {
      const pair = await this.createOrReuseOp({
        slaveTerminalId: slave.id,
        masterTerminalId,
        masterTicket: evt.ticket,
        action: 'place_pending',
        eventKey,
        detectedAt,
        payload,
      })
      if (!pair) return false
      op = pair.op
    }

    const failFast = async (status: 'skipped' | 'failed', code: string, reason: string, withMetric: boolean) => {
      const doneAt = Date.now()
      await this.finishOp(op!.id, {
        status,
        failCode: code,
        failReason: reason,
        doneAt,
        ...(status === 'failed' ? { latencyMs: Math.max(0, doneAt - detectedAt), totalMs: Math.max(0, doneAt - detectedAt) } : {}),
      })
      if (withMetric) {
        await this.writeMetric({
          ts: detectedAt,
          slaveTerminalId: slave.id,
          masterTicket: evt.ticket,
          action: 'place_pending',
          totalMs: Math.max(0, doneAt - detectedAt),
          ok: false,
        })
      }
      await logEvent({
        level: status === 'failed' ? 'error' : 'warn',
        category: 'copy',
        terminalId: slave.id,
        terminalName: slave.name,
        message: `Pending copy ${status} for master #${evt.ticket} ${evt.symbol}: ${reason}`,
        details: `code=${code}`,
      })
      return false
    }

    try {
      if (!copyEnabled) return await failFast('skipped', 'copy_disabled', 'Global copying is stopped', false)
      const mapped = mapSymbol(evt.symbol, s.symbolMapping)
      const link = this.links.get(slave.id) ?? null
      const spec = link ? link.getSymbolSpec(mapped) : null
      const openPositionsCount = await db.position.count({
        where: { terminalId: slave.id, kind: 'position' },
      })
      const guard = checkCopyAllowed({
        slave: {
          role: 'slave',
          enabled: slave.enabled,
          paused: slave.paused,
          status: slave.status as TerminalStatus,
        },
        settings: toSettingsDTO(s),
        symbol: evt.symbol,
        side: evt.side ?? 'buy',
        kind: 'pending',
        spec,
        openPositionsCount,
      })
      if (!guard.allowed) return await failFast('skipped', guard.code, guard.reason, false)
      if (!spec) {
        return await failFast('failed', 'unknown_symbol', `Symbol ${mapped} not found on slave terminal`, true)
      }
      const slDistancePoints = evt.sl && evt.price ? Math.abs(evt.price - evt.sl) / (spec.point || 1) : 0
      const lot = calcVolume({
        mode: s.lotMode as LotMode,
        masterVolume: evt.volume ?? 0,
        masterBalance: (await db.terminal.findUnique({ where: { id: masterTerminalId } }))?.balance ?? 0,
        slaveEquity: slave.equity,
        fixedLot: s.fixedLot,
        multiplier: s.multiplier,
        balanceRatioCap: s.balanceRatioCap,
        riskPercent: s.riskPercent,
        slDistancePoints,
        spec,
        maxLotLimit: s.maxLot,
      })
      if (!lot.ok) return await failFast('failed', lot.code, lot.reason, true)
      if (!link || !link.isConnected()) {
        return await failFast('failed', 'offline', 'Slave terminal is not connected', true)
      }
      const sentAt = Date.now()
      await this.finishOp(op.id, { status: 'sent', sentAt })
      const res = await link.send({
        kind: 'place_pending',
        symbol: mapped,
        side: evt.side ?? 'buy',
        volume: lot.volume,
        price: evt.price,
        sl: s.copySL ? evt.sl ?? 0 : 0,
        tp: s.copyTP ? evt.tp ?? 0 : 0,
        pendingType: evt.pendingType,
        masterTicket: evt.ticket,
        eventKey,
      })
      const ackAt = res.at || Date.now()
      const doneAt = Date.now()
      if (res.ok && res.ticket) {
        await this.finishOp(op.id, {
          status: 'executed',
          slaveTicket: res.ticket,
          ackAt,
          doneAt,
          latencyMs: Math.max(0, ackAt - detectedAt),
          totalMs: Math.max(0, doneAt - detectedAt),
          failCode: '',
          failReason: '',
        })
        await db.position.upsert({
          where: { terminalId_ticket: { terminalId: slave.id, ticket: res.ticket } },
          update: { masterTicket: evt.ticket, copiedByEngine: true },
          create: {
            terminalId: slave.id,
            ticket: res.ticket,
            symbol: mapped,
            side: evt.side ?? 'buy',
            kind: 'pending',
            pendingType: evt.pendingType ?? '',
            volume: lot.volume,
            openPrice: evt.price ?? 0,
            currentPrice: evt.price ?? 0,
            sl: s.copySL ? evt.sl ?? 0 : 0,
            tp: s.copyTP ? evt.tp ?? 0 : 0,
            profit: 0,
            openTime: doneAt,
            masterTicket: evt.ticket,
            copiedByEngine: true,
          },
        })
        await this.writeMetric({
          ts: detectedAt,
          slaveTerminalId: slave.id,
          masterTicket: evt.ticket,
          action: 'place_pending',
          detectMs: Math.max(0, sentAt - detectedAt),
          sendMs: Math.max(0, ackAt - sentAt),
          ackMs: Math.max(0, doneAt - ackAt),
          totalMs: Math.max(0, doneAt - detectedAt),
          ok: true,
        })
        await logEvent({
          level: 'success',
          category: 'copy',
          terminalId: slave.id,
          terminalName: slave.name,
          message: `Copied pending master #${evt.ticket} ${evt.pendingType ?? ''} ${evt.symbol} -> ${mapped} ${lot.volume} lots @ ${evt.price ?? '-'}`,
          details: `slaveTicket=${res.ticket} latency=${ackAt - detectedAt}ms`,
        })
        return true
      }
      return await failFast('failed', res.code ?? 'broker_reject', res.error ?? 'Broker rejected the order', true)
    } catch (e) {
      try {
        await this.finishOp(op.id, { status: 'failed', failCode: 'engine_error', failReason: String(e), doneAt: Date.now() })
      } catch {
        // ignore
      }
      await logEvent({
        level: 'error',
        category: 'copy',
        terminalId: slave.id,
        terminalName: slave.name,
        message: `Pending copy pipeline error for master #${evt.ticket}`,
        details: String(e),
      }).catch(() => undefined)
      return false
    }
  }

  private async handleMasterPendingCancelled(t: TerminalRow, evt: TradeEvent): Promise<void> {
    const detectedAt = Date.now()
    await this.touchLastEventAt(detectedAt)
    await db.position.deleteMany({
      where: { terminalId: t.id, ticket: evt.ticket, kind: 'pending' },
    })
    await logEvent({
      level: 'info',
      category: 'trade',
      terminalId: t.id,
      terminalName: t.name,
      message: `Master cancelled pending #${evt.ticket} ${evt.symbol}`,
    })
    const slaves = await db.terminal.findMany({ where: { role: 'slave' }, include: { slaveSettings: true } })
    await Promise.allSettled(slaves.map((s) => this.cancelPendingOnSlave(s, evt, t.id, detectedAt)))
  }

  private async cancelPendingOnSlave(
    slave: TerminalRow,
    evt: TradeEvent,
    masterTerminalId: string,
    detectedAt: number,
  ): Promise<boolean> {
    const s = slave.slaveSettings ?? (await this.ensureSlaveSettingsRow(slave.id))
    const eventKey = `pcancel:${evt.ticket}`
    const op = await this.tryCreateOp({
      slaveTerminalId: slave.id,
      masterTerminalId,
      masterTicket: evt.ticket,
      action: 'cancel_pending',
      eventKey,
      detectedAt,
      payload: '{}',
    })
    if (!op) return false
    try {
      if (!s.copyPending) {
        await this.finishOp(op.id, {
          status: 'skipped',
          failCode: 'pending_disabled',
          failReason: 'copyPending is disabled; slave never received the pending order',
          doneAt: Date.now(),
        })
        return false
      }
      const slavePending = await db.position.findFirst({
        where: { terminalId: slave.id, masterTicket: evt.ticket, kind: 'pending' },
      })
      if (!slavePending) {
        await this.finishOp(op.id, {
          status: 'missed',
          failCode: 'no_position',
          failReason: 'No copied pending order found on slave',
          doneAt: Date.now(),
        })
        return false
      }
      const link = this.links.get(slave.id) ?? null
      if (!link || !link.isConnected()) {
        await this.finishOp(op.id, { status: 'failed', failCode: 'offline', failReason: 'Slave terminal is not connected', doneAt: Date.now() })
        return false
      }
      const sentAt = Date.now()
      await this.finishOp(op.id, { status: 'sent', sentAt })
      const res = await link.send({
        kind: 'cancel_pending',
        ticket: slavePending.ticket,
        symbol: slavePending.symbol,
      })
      const ackAt = res.at || Date.now()
      const doneAt = Date.now()
      if (res.ok) {
        await this.finishOp(op.id, {
          status: 'executed',
          slaveTicket: slavePending.ticket,
          ackAt,
          doneAt,
          latencyMs: Math.max(0, ackAt - detectedAt),
          totalMs: Math.max(0, doneAt - detectedAt),
          failCode: '',
          failReason: '',
        })
        await db.position.deleteMany({
          where: { terminalId: slave.id, ticket: slavePending.ticket, kind: 'pending' },
        })
        await logEvent({
          level: 'success',
          category: 'copy',
          terminalId: slave.id,
          terminalName: slave.name,
          message: `Cancelled slave pending ${slavePending.ticket} (master #${evt.ticket})`,
        })
        return true
      }
      await this.finishOp(op.id, {
        status: 'failed',
        failCode: res.code ?? 'broker_reject',
        failReason: res.error ?? 'Broker rejected',
        ackAt,
        doneAt,
        latencyMs: Math.max(0, ackAt - detectedAt),
        totalMs: Math.max(0, doneAt - detectedAt),
      })
      return false
    } catch (e) {
      try {
        await this.finishOp(op.id, { status: 'failed', failCode: 'engine_error', failReason: String(e), doneAt: Date.now() })
      } catch {
        // ignore
      }
      await logEvent({
        level: 'error',
        category: 'copy',
        terminalId: slave.id,
        terminalName: slave.name,
        message: `Cancel pending pipeline error for master #${evt.ticket}`,
        details: String(e),
      }).catch(() => undefined)
      return false
    }
  }

  private async handleMasterPendingFilled(t: TerminalRow, evt: TradeEvent): Promise<void> {
    await this.touchLastEventAt(Date.now())
    await db.position.updateMany({
      where: { terminalId: t.id, ticket: evt.ticket, kind: 'pending' },
      data: { kind: 'position', openPrice: evt.price ?? 0, currentPrice: evt.price ?? 0, openTime: evt.ts },
    })
    // Per spec: pending_filled on the master does NOT trigger copying.
    // Slave pending copies fill on their own price triggers; drift is
    // reported by reconciliation.
    await logEvent({
      level: 'info',
      category: 'trade',
      terminalId: t.id,
      terminalName: t.name,
      message: `Master pending #${evt.ticket} filled at ${evt.price ?? '-'}`,
    })
  }

  // ---------- slave-side event handling (ledger accuracy only) ----------

  private async handleSlavePositionOpened(t: TerminalRow, evt: TradeEvent): Promise<void> {
    await db.position.upsert({
      where: { terminalId_ticket: { terminalId: t.id, ticket: evt.ticket } },
      update: { currentPrice: evt.price ?? 0 },
      create: {
        terminalId: t.id,
        ticket: evt.ticket,
        symbol: evt.symbol,
        side: evt.side ?? 'buy',
        kind: 'position',
        pendingType: '',
        volume: evt.volume,
        openPrice: evt.price ?? 0,
        currentPrice: evt.price ?? 0,
        sl: evt.sl ?? 0,
        tp: evt.tp ?? 0,
        profit: 0,
        openTime: evt.ts,
        masterTicket: '',
        copiedByEngine: false,
      },
    })
    const row = await db.position.findUnique({
      where: { terminalId_ticket: { terminalId: t.id, ticket: evt.ticket } },
    })
    if (row && !row.masterTicket) {
      await logEvent({
        level: 'info',
        category: 'trade',
        terminalId: t.id,
        terminalName: t.name,
        message: `Slave opened own trade (not copied): ${evt.side ?? 'buy'} ${evt.symbol} ${evt.volume} lots @ ${evt.price ?? '-'}`,
        details: `ticket=${evt.ticket}`,
      })
    }
  }

  private async handleSlavePositionClosed(t: TerminalRow, evt: TradeEvent): Promise<void> {
    const pos = await db.position.findUnique({
      where: { terminalId_ticket: { terminalId: t.id, ticket: evt.ticket } },
    })
    if (pos) {
      const spec = this.links.get(t.id)?.getSymbolSpec(evt.symbol) ?? null
      const closePrice = evt.price ?? pos.currentPrice
      const profit = this.estimateProfit(
        pos.symbol,
        pos.side as 'buy' | 'sell',
        pos.volume,
        pos.openPrice,
        closePrice,
        spec,
      )
      const closeReason = evt.closeReason ?? 'manual'
      await db.closedTrade.upsert({
        where: { terminalId_ticket: { terminalId: t.id, ticket: evt.ticket } },
        update: { closePrice, closeReason, profit, closeTime: evt.ts },
        create: {
          terminalId: t.id,
          ticket: pos.ticket,
          symbol: pos.symbol,
          side: pos.side,
          kind: pos.kind,
          pendingType: pos.pendingType,
          volume: pos.volume,
          openPrice: pos.openPrice,
          closePrice,
          sl: pos.sl,
          tp: pos.tp,
          profit,
          openTime: pos.openTime,
          closeTime: evt.ts,
          closeReason,
          masterTicket: pos.masterTicket,
        },
      })
      await db.position.delete({ where: { id: pos.id } }).catch(() => undefined)
    }
    // Was this close commanded by the engine?
    const closeOp = await db.copyOperation.findFirst({
      where: { slaveTerminalId: t.id, slaveTicket: evt.ticket, action: 'close', status: { in: ['sent', 'executed'] } },
    })
    if (closeOp) {
      if (closeOp.status === 'sent') {
        // Defensive finalize (the close pipeline normally does this).
        const doneAt = Date.now()
        await this.finishOp(closeOp.id, {
          status: 'executed',
          doneAt,
          ackAt: closeOp.ackAt || doneAt,
          latencyMs: Math.max(0, (closeOp.ackAt || doneAt) - closeOp.detectedAt),
          totalMs: Math.max(0, doneAt - closeOp.detectedAt),
        })
      }
    } else {
      await logEvent({
        level: 'info',
        category: 'trade',
        terminalId: t.id,
        terminalName: t.name,
        message: `Slave closed independently: ${evt.side ?? 'buy'} ${evt.symbol} ${evt.volume} lots (${evt.closeReason ?? 'manual'})`,
        details: `ticket=${evt.ticket} price=${evt.price ?? '-'}`,
      })
      if (pos && pos.masterTicket) {
        const mp = await db.position.findFirst({ where: { ticket: pos.masterTicket, terminal: { role: 'master' } } })
        if (mp) {
          await logEvent({
            level: 'warn',
            category: 'sync',
            terminalId: t.id,
            terminalName: t.name,
            message: `Drift: slave closed copied position ${evt.ticket} independently while master #${pos.masterTicket} is still open`,
            details: `${pos.symbol} ${pos.volume} lots`,
          })
        }
      }
    }
    this.flushAccountNow(t.id)
  }

  private async handleSlavePartialClosed(t: TerminalRow, evt: TradeEvent): Promise<void> {
    const pos = await db.position.findUnique({
      where: { terminalId_ticket: { terminalId: t.id, ticket: evt.ticket } },
    })
    if (pos) {
      await db.position
        .update({
          where: { id: pos.id },
          data: { volume: evt.volume ?? pos.volume, currentPrice: evt.price ?? pos.currentPrice },
        })
        .catch(() => undefined)
    }
    const op = await db.copyOperation.findFirst({
      where: { slaveTerminalId: t.id, slaveTicket: evt.ticket, action: 'partial', status: 'sent' },
    })
    if (op) {
      const doneAt = Date.now()
      await this.finishOp(op.id, {
        status: 'executed',
        doneAt,
        ackAt: op.ackAt || doneAt,
        latencyMs: Math.max(0, (op.ackAt || doneAt) - op.detectedAt),
        totalMs: Math.max(0, doneAt - op.detectedAt),
      })
    } else {
      await logEvent({
        level: 'info',
        category: 'trade',
        terminalId: t.id,
        terminalName: t.name,
        message: `Slave partial close (independent): ${evt.symbol} closed ${evt.closedVolume ?? 0} lots, ${evt.volume} remaining`,
        details: `ticket=${evt.ticket}`,
      })
    }
  }

  private async handleSlaveSltpModified(t: TerminalRow, evt: TradeEvent): Promise<void> {
    await db.position
      .updateMany({
        where: { terminalId: t.id, ticket: evt.ticket },
        data: { sl: evt.sl ?? 0, tp: evt.tp ?? 0 },
      })
      .catch(() => undefined)
    const op = await db.copyOperation.findFirst({
      where: { slaveTerminalId: t.id, slaveTicket: evt.ticket, action: 'modify_sltp', status: 'sent' },
    })
    if (!op) {
      await logEvent({
        level: 'info',
        category: 'trade',
        terminalId: t.id,
        terminalName: t.name,
        message: `Slave modified SL/TP independently: ${evt.symbol} sl=${evt.sl ?? 0} tp=${evt.tp ?? 0}`,
        details: `ticket=${evt.ticket}`,
      })
    }
  }

  private async handleSlavePendingPlaced(t: TerminalRow, evt: TradeEvent): Promise<void> {
    await db.position.upsert({
      where: { terminalId_ticket: { terminalId: t.id, ticket: evt.ticket } },
      update: { currentPrice: evt.price ?? 0 },
      create: {
        terminalId: t.id,
        ticket: evt.ticket,
        symbol: evt.symbol,
        side: evt.side ?? 'buy',
        kind: 'pending',
        pendingType: evt.pendingType ?? '',
        volume: evt.volume,
        openPrice: evt.price ?? 0,
        currentPrice: evt.price ?? 0,
        sl: evt.sl ?? 0,
        tp: evt.tp ?? 0,
        profit: 0,
        openTime: evt.ts,
        masterTicket: '',
        copiedByEngine: false,
      },
    })
    const op = await db.copyOperation.findFirst({
      where: { slaveTerminalId: t.id, slaveTicket: evt.ticket, action: 'place_pending', status: 'sent' },
    })
    if (!op) {
      await logEvent({
        level: 'info',
        category: 'trade',
        terminalId: t.id,
        terminalName: t.name,
        message: `Slave placed own pending ${evt.pendingType ?? ''} ${evt.symbol} ${evt.volume} lots @ ${evt.price ?? '-'}`,
        details: `ticket=${evt.ticket}`,
      })
    }
  }

  private async handleSlavePendingCancelled(t: TerminalRow, evt: TradeEvent): Promise<void> {
    await db.position
      .deleteMany({ where: { terminalId: t.id, ticket: evt.ticket, kind: 'pending' } })
      .catch(() => undefined)
    const op = await db.copyOperation.findFirst({
      where: { slaveTerminalId: t.id, slaveTicket: evt.ticket, action: 'cancel_pending', status: 'sent' },
    })
    if (!op) {
      await logEvent({
        level: 'info',
        category: 'trade',
        terminalId: t.id,
        terminalName: t.name,
        message: `Slave cancelled own pending #${evt.ticket} ${evt.symbol}`,
      })
    }
  }

  private async handleSlavePendingFilled(t: TerminalRow, evt: TradeEvent): Promise<void> {
    const pos = await db.position.findUnique({
      where: { terminalId_ticket: { terminalId: t.id, ticket: evt.ticket } },
    })
    if (pos && pos.kind === 'pending') {
      await db.position
        .update({
          where: { id: pos.id },
          data: {
            kind: 'position',
            openPrice: evt.price ?? pos.openPrice,
            currentPrice: evt.price ?? pos.openPrice,
            openTime: evt.ts,
          },
        })
        .catch(() => undefined)
      if (pos.masterTicket) {
        await db.copyOperation.updateMany({
          where: { slaveTerminalId: t.id, masterTicket: pos.masterTicket, action: 'place_pending' },
          data: { status: 'executed' },
        })
        await logEvent({
          level: 'info',
          category: 'trade',
          terminalId: t.id,
          terminalName: t.name,
          message: `Slave pending #${evt.ticket} filled (copied from master #${pos.masterTicket})`,
          details: `${pos.symbol} ${pos.volume} lots @ ${evt.price ?? '-'}`,
        })
      } else {
        await logEvent({
          level: 'info',
          category: 'trade',
          terminalId: t.id,
          terminalName: t.name,
          message: `Slave own pending #${evt.ticket} filled`,
          details: `${pos.symbol} ${pos.volume} lots @ ${evt.price ?? '-'}`,
        })
      }
    }
  }

  // ---------- queries ----------

  async getSnapshot(): Promise<SnapshotDTO> {
    const now = Date.now()
    const settings = await this.ensureAppSettingsRow()
    const terminals = await db.terminal.findMany({ include: { slaveSettings: true } })
    const posRows = await db.position.findMany({ select: { terminalId: true, kind: true } })
    const counts = new Map<string, { open: number; pending: number }>()
    let openPositionsTotal = 0
    let pendingTotal = 0
    for (const p of posRows) {
      const c = counts.get(p.terminalId) ?? { open: 0, pending: 0 }
      if (p.kind === 'pending') {
        c.pending++
        pendingTotal++
      } else {
        c.open++
        openPositionsTotal++
      }
      counts.set(p.terminalId, c)
    }
    const dtos = terminals.map((t) => this.toTerminalDTO(t, counts.get(t.id) ?? { open: 0, pending: 0 }))
    const master = terminals.find((t) => t.role === 'master')
    const startOfDay = new Date()
    startOfDay.setHours(0, 0, 0, 0)
    const [okToday, failToday] = await Promise.all([
      db.metricEvent.count({ where: { ts: { gte: startOfDay.getTime() }, ok: true } }),
      db.metricEvent.count({ where: { ts: { gte: startOfDay.getTime() }, ok: false } }),
    ])
    const stats: EngineStatsDTO = {
      engineRunning: this.running,
      copyEnabled: settings.copyEnabled,
      emergencyPolicy: settings.emergencyPolicy as EmergencyPolicy,
      masterStatus: master ? (master.status as TerminalStatus) : 'none',
      masterName: master?.name ?? '',
      totalTerminals: terminals.length,
      connectedTerminals: dtos.filter((t) => t.status === 'connected').length,
      activeSlaves: dtos.filter((t) => t.role === 'slave' && t.enabled && !t.paused).length,
      openPositionsTotal,
      pendingTotal,
      copiedToday: okToday,
      failedToday: failToday,
      lastEventAt: settings.lastEventAt,
      bootedAt: this.bootedAt,
      now,
    }
    const [masterRelations, latency] = await Promise.all([
      this.buildMasterRelations(master?.id ?? null),
      this.getLatencyStats(),
    ])
    return { stats, terminals: dtos, masterRelations, latency }
  }

  private async buildMasterRelations(masterId: string | null): Promise<MasterTradeRelationDTO[]> {
    if (!masterId) return []
    const openRows = await db.position.findMany({
      where: { terminalId: masterId },
      orderBy: { openTime: 'desc' },
    })
    const cutoff = Date.now() - 30 * 60 * 1000
    const closedRows = await db.closedTrade.findMany({
      where: { terminalId: masterId, closeTime: { gte: cutoff } },
      orderBy: { closeTime: 'desc' },
    })
    const tickets = [...openRows.map((r) => r.ticket), ...closedRows.map((r) => r.ticket)]
    if (tickets.length === 0) return []
    const [ops, terminals] = await Promise.all([
      db.copyOperation.findMany({ where: { masterTicket: { in: tickets } }, orderBy: { detectedAt: 'asc' } }),
      db.terminal.findMany({ select: { id: true, name: true } }),
    ])
    const slaveNames = new Map(terminals.map((t) => [t.id, t.name]))
    const opDto = (o: DbCopyOperation): CopyOperationDTO => ({
      id: o.id,
      masterTerminalId: o.masterTerminalId,
      slaveTerminalId: o.slaveTerminalId,
      slaveName: slaveNames.get(o.slaveTerminalId) ?? '',
      masterTicket: o.masterTicket,
      slaveTicket: o.slaveTicket,
      action: o.action as CopyAction,
      eventKey: o.eventKey,
      status: o.status as CopyOpStatus,
      failReason: o.failReason,
      failCode: o.failCode,
      detectedAt: o.detectedAt,
      sentAt: o.sentAt,
      ackAt: o.ackAt,
      doneAt: o.doneAt,
      latencyMs: o.latencyMs,
      totalMs: o.totalMs,
    })
    const out: MasterTradeRelationDTO[] = []
    for (const r of openRows) {
      out.push({
        masterTicket: r.ticket,
        symbol: r.symbol,
        side: r.side as 'buy' | 'sell',
        volume: r.volume,
        openPrice: r.openPrice,
        sl: r.sl,
        tp: r.tp,
        openTime: r.openTime,
        profit: r.profit,
        isOpen: true,
        copies: ops.filter((o) => o.masterTicket === r.ticket).map(opDto),
      })
    }
    for (const r of closedRows) {
      if (openRows.some((x) => x.ticket === r.ticket)) continue
      out.push({
        masterTicket: r.ticket,
        symbol: r.symbol,
        side: r.side as 'buy' | 'sell',
        volume: r.volume,
        openPrice: r.openPrice,
        sl: r.sl,
        tp: r.tp,
        openTime: r.openTime,
        profit: r.profit,
        isOpen: false,
        copies: ops.filter((o) => o.masterTicket === r.ticket).map(opDto),
      })
    }
    return out
  }

  async getOpenPositions(f?: { terminalId?: string; kind?: 'position' | 'pending' }): Promise<PositionDTO[]> {
    const where: Prisma.PositionWhereInput = {}
    if (f?.terminalId) where.terminalId = f.terminalId
    if (f?.kind) where.kind = f.kind
    const [rows, terminals] = await Promise.all([
      db.position.findMany({ where, orderBy: { openTime: 'desc' } }),
      db.terminal.findMany({ select: { id: true, name: true, role: true } }),
    ])
    const tmap = new Map(terminals.map((t) => [t.id, t]))
    return rows.map((r) => ({
      id: r.id,
      terminalId: r.terminalId,
      terminalName: tmap.get(r.terminalId)?.name ?? '',
      terminalRole: (tmap.get(r.terminalId)?.role as TerminalRole) ?? 'none',
      ticket: r.ticket,
      symbol: r.symbol,
      side: r.side as 'buy' | 'sell',
      kind: r.kind as 'position' | 'pending',
      pendingType: r.pendingType,
      volume: r.volume,
      openPrice: r.openPrice,
      currentPrice: r.currentPrice,
      sl: r.sl,
      tp: r.tp,
      profit: r.profit,
      openTime: r.openTime,
      masterTicket: r.masterTicket,
      copiedByEngine: r.copiedByEngine,
    }))
  }

  async getClosedTrades(f?: {
    terminalId?: string
    symbol?: string
    from?: number
    to?: number
    q?: string
    limit?: number
  }): Promise<ClosedTradeDTO[]> {
    const where: Prisma.ClosedTradeWhereInput = {}
    if (f?.terminalId) where.terminalId = f.terminalId
    if (f?.symbol) where.symbol = { contains: f.symbol }
    if (f?.from !== undefined || f?.to !== undefined) {
      where.closeTime = {
        ...(f?.from !== undefined ? { gte: f.from } : {}),
        ...(f?.to !== undefined ? { lte: f.to } : {}),
      }
    }
    if (f?.q) {
      where.OR = [
        { symbol: { contains: f.q } },
        { ticket: { contains: f.q } },
        { masterTicket: { contains: f.q } },
      ]
    }
    const [rows, terminals] = await Promise.all([
      db.closedTrade.findMany({
        where,
        orderBy: { closeTime: 'desc' },
        take: Math.min(Math.max(1, f?.limit ?? 200), 1000),
      }),
      db.terminal.findMany({ select: { id: true, name: true, role: true } }),
    ])
    const tmap = new Map(terminals.map((t) => [t.id, t]))
    return rows.map((r) => ({
      id: r.id,
      terminalId: r.terminalId,
      terminalName: tmap.get(r.terminalId)?.name ?? '',
      terminalRole: (tmap.get(r.terminalId)?.role as TerminalRole) ?? 'none',
      ticket: r.ticket,
      symbol: r.symbol,
      side: r.side as 'buy' | 'sell',
      kind: r.kind,
      volume: r.volume,
      openPrice: r.openPrice,
      closePrice: r.closePrice,
      sl: r.sl,
      tp: r.tp,
      profit: r.profit,
      openTime: r.openTime,
      closeTime: r.closeTime,
      closeReason: r.closeReason,
      masterTicket: r.masterTicket,
    }))
  }

  async getLogs(f?: {
    level?: string
    category?: string
    terminalId?: string
    q?: string
    limit?: number
    beforeTs?: number
  }): Promise<LogDTO[]> {
    const where: Prisma.LogEntryWhereInput = {}
    if (f?.level) where.level = f.level
    if (f?.category) where.category = f.category
    if (f?.terminalId) where.terminalId = f.terminalId
    if (f?.beforeTs !== undefined) where.ts = { lt: f.beforeTs }
    if (f?.q) {
      where.OR = [{ message: { contains: f.q } }, { details: { contains: f.q } }]
    }
    const rows = await db.logEntry.findMany({
      where,
      orderBy: { ts: 'desc' },
      take: Math.min(Math.max(1, f?.limit ?? 200), 1000),
    })
    return rows.map((r) => ({
      id: r.id,
      ts: r.ts,
      level: r.level as LogDTO['level'],
      category: r.category,
      terminalId: r.terminalId,
      terminalName: r.terminalName,
      message: r.message,
      details: r.details,
    }))
  }

  async getCopyOpsByMasterTicket(ticket: string): Promise<CopyOperationDTO[]> {
    const [rows, terminals] = await Promise.all([
      db.copyOperation.findMany({ where: { masterTicket: ticket }, orderBy: { detectedAt: 'asc' } }),
      db.terminal.findMany({ select: { id: true, name: true } }),
    ])
    const slaveNames = new Map(terminals.map((t) => [t.id, t.name]))
    return rows.map((o) => ({
      id: o.id,
      masterTerminalId: o.masterTerminalId,
      slaveTerminalId: o.slaveTerminalId,
      slaveName: slaveNames.get(o.slaveTerminalId) ?? '',
      masterTicket: o.masterTicket,
      slaveTicket: o.slaveTicket,
      action: o.action as CopyAction,
      eventKey: o.eventKey,
      status: o.status as CopyOpStatus,
      failReason: o.failReason,
      failCode: o.failCode,
      detectedAt: o.detectedAt,
      sentAt: o.sentAt,
      ackAt: o.ackAt,
      doneAt: o.doneAt,
      latencyMs: o.latencyMs,
      totalMs: o.totalMs,
    }))
  }

  async getLatencyStats(): Promise<LatencyStatsDTO> {
    const now = Date.now()
    const dayAgo = now - 24 * 3600 * 1000
    const startOfDay = new Date()
    startOfDay.setHours(0, 0, 0, 0)
    const samples = await db.metricEvent.findMany({ where: { ts: { gte: dayAgo } }, orderBy: { ts: 'asc' } })
    const totals = samples.map((s) => s.totalMs)
    const current = totals.length > 0 ? totals[totals.length - 1] : 0
    const average =
      totals.length > 0 ? Math.round(totals.reduce((a, b) => a + b, 0) / totals.length) : 0
    const min = totals.length > 0 ? Math.min(...totals) : 0
    const max = totals.length > 0 ? Math.max(...totals) : 0
    const [okToday, failToday, missedToday, settings, reconnectAgg, terminals] = await Promise.all([
      db.metricEvent.count({ where: { ts: { gte: startOfDay.getTime() }, ok: true } }),
      db.metricEvent.count({ where: { ts: { gte: startOfDay.getTime() }, ok: false } }),
      db.copyOperation.count({ where: { status: 'missed', detectedAt: { gte: startOfDay.getTime() } } }),
      this.ensureAppSettingsRow(),
      db.terminal.aggregate({ _sum: { reconnectCount: true } }),
      db.terminal.findMany({ select: { id: true, name: true } }),
    ])
    const recent = samples.slice(-60).map((s) => ({ ts: s.ts, totalMs: s.totalMs, ok: s.ok }))
    const bySlave = new Map<string, DbMetricEvent[]>()
    for (const s of samples) {
      const arr = bySlave.get(s.slaveTerminalId) ?? []
      arr.push(s)
      bySlave.set(s.slaveTerminalId, arr)
    }
    const nameById = new Map(terminals.map((t) => [t.id, t.name]))
    const perSlave = [...bySlave.entries()].map(([terminalId, arr]) => {
      const last100 = arr.slice(-100)
      const okCount = last100.filter((x) => x.ok).length
      return {
        terminalId,
        name: nameById.get(terminalId) ?? '',
        avgMs:
          last100.length > 0
            ? Math.round(last100.reduce((a, b) => a + b.totalMs, 0) / last100.length)
            : 0,
        count: last100.length,
        ok: okCount,
        failed: last100.length - okCount,
      }
    })
    return {
      current,
      average,
      min,
      max,
      samples: totals.length,
      successfulCopies: okToday,
      failedCopies: failToday,
      missedEvents: missedToday,
      reconnectionEvents: reconnectAgg._sum.reconnectCount ?? 0,
      lastEventAt: settings.lastEventAt,
      recent,
      perSlave,
    }
  }

  // ---------- internal helpers ----------

  private async ensureAppSettingsRow(): Promise<DbAppSettings> {
    const existing = await db.appSettings.findUnique({ where: { id: 'singleton' } })
    if (existing) return existing
    try {
      return await db.appSettings.create({ data: { id: 'singleton' } })
    } catch {
      const r = await db.appSettings.findUnique({ where: { id: 'singleton' } })
      if (r) return r
      throw new Error('AppSettings singleton unavailable')
    }
  }

  private async ensureSlaveSettingsRow(terminalId: string): Promise<SlaveSettings> {
    const existing = await db.slaveSettings.findUnique({ where: { terminalId } })
    if (existing) return existing
    try {
      return await db.slaveSettings.create({ data: { terminalId } })
    } catch {
      const r = await db.slaveSettings.findUnique({ where: { terminalId } })
      if (r) return r
      throw new Error(`SlaveSettings unavailable for ${terminalId}`)
    }
  }

  private async tryCreateOp(data: {
    slaveTerminalId: string
    masterTerminalId: string
    masterTicket: string
    action: CopyAction
    eventKey: string
    detectedAt: number
    payload?: string
  }): Promise<DbCopyOperation | null> {
    const existing = await db.copyOperation.findUnique({
      where: {
        slaveTerminalId_eventKey: {
          slaveTerminalId: data.slaveTerminalId,
          eventKey: data.eventKey,
        },
      },
    })
    if (existing) return null
    try {
      return await db.copyOperation.create({ data: { ...data, payload: data.payload ?? '{}' } })
    } catch {
      // Unique violation race: another path created it first -> skip.
      return null
    }
  }

  /**
   * Create an op or reuse a non-executed one (used by sync flows so that a
   * previously skipped/failed op can be retried without ever duplicating an
   * executed order).
   */
  private async createOrReuseOp(data: {
    slaveTerminalId: string
    masterTerminalId: string
    masterTicket: string
    action: CopyAction
    eventKey: string
    detectedAt: number
    payload?: string
  }): Promise<{ op: DbCopyOperation; created: boolean } | null> {
    const existing = await db.copyOperation.findUnique({
      where: {
        slaveTerminalId_eventKey: {
          slaveTerminalId: data.slaveTerminalId,
          eventKey: data.eventKey,
        },
      },
    })
    if (existing) {
      if (existing.status === 'executed' || existing.status === 'sent') return null
      const op = await db.copyOperation.update({
        where: { id: existing.id },
        data: {
          status: 'pending',
          failCode: '',
          failReason: '',
          masterTerminalId: data.masterTerminalId,
          detectedAt: data.detectedAt,
          sentAt: 0,
          ackAt: 0,
          doneAt: 0,
          latencyMs: 0,
          totalMs: 0,
          payload: data.payload ?? '{}',
        },
      })
      return { op, created: false }
    }
    try {
      const op = await db.copyOperation.create({ data: { ...data, payload: data.payload ?? '{}' } })
      return { op, created: true }
    } catch {
      return null
    }
  }

  private async finishOp(id: string, patch: OpPatch): Promise<void> {
    try {
      await db.copyOperation.update({ where: { id }, data: patch })
    } catch (e) {
      await logEvent({
        level: 'warn',
        category: 'copy',
        message: 'Failed to update copy operation',
        details: String(e),
      }).catch(() => undefined)
    }
  }

  private async writeMetric(m: MetricInput): Promise<void> {
    try {
      await db.metricEvent.create({
        data: {
          ts: m.ts,
          slaveTerminalId: m.slaveTerminalId,
          masterTicket: m.masterTicket,
          action: m.action,
          detectMs: Math.round(m.detectMs ?? 0),
          sendMs: Math.round(m.sendMs ?? 0),
          ackMs: Math.round(m.ackMs ?? 0),
          totalMs: Math.round(m.totalMs),
          ok: m.ok,
        },
      })
    } catch (e) {
      await logEvent({
        level: 'warn',
        category: 'engine',
        message: 'Failed to write metric event',
        details: String(e),
      }).catch(() => undefined)
    }
  }

  private async touchLastEventAt(ts: number): Promise<void> {
    if (ts - this.lastEventTouch < 1000) return
    this.lastEventTouch = ts
    try {
      await db.appSettings.update({ where: { id: 'singleton' }, data: { lastEventAt: ts } })
    } catch {
      // ignore
    }
  }

  private estimateProfit(
    symbol: string,
    side: 'buy' | 'sell',
    volume: number,
    openPrice: number,
    closePrice: number,
    spec: SymbolSpec | null,
  ): number {
    void symbol
    if (!spec || volume <= 0 || !openPrice || !closePrice) return 0
    const valuePerPointPerLot = spec.tickValue * (spec.point / spec.tickSize)
    const diff = side === 'buy' ? closePrice - openPrice : openPrice - closePrice
    return round2((diff / spec.point) * valuePerPointPerLot * volume)
  }

  private toTerminalDTO(
    t: TerminalRow,
    counts: { open: number; pending: number },
  ): TerminalDTO {
    return {
      id: t.id,
      name: t.name,
      broker: t.broker,
      server: t.server,
      accountNumber: t.accountNumber,
      currency: t.currency,
      exePath: t.exePath,
      simulated: t.simulated,
      role: t.role as TerminalRole,
      enabled: t.enabled,
      paused: t.paused,
      status: t.status as TerminalStatus,
      autoReconnect: t.autoReconnect,
      lastSeen: t.lastSeen,
      leverage: t.leverage,
      balance: round2(t.balance),
      equity: round2(t.equity),
      floatingPL: round2(t.floatingPL),
      freeMargin: round2(t.freeMargin),
      marginLevel: round2(t.marginLevel),
      closedToday: t.closedToday,
      reconnectCount: t.reconnectCount,
      openPositionsCount: counts.open,
      pendingCount: counts.pending,
      settings: t.slaveSettings ? toSettingsDTO(t.slaveSettings) : null,
    }
  }
}

// globalThis singleton: survives Next.js dev hot reloads (same pattern as db.ts).
const g = globalThis as unknown as { __copierEngine?: CopierEngine }

export function getEngine(): CopierEngine {
  if (!g.__copierEngine) g.__copierEngine = new CopierEngine()
  return g.__copierEngine
}
