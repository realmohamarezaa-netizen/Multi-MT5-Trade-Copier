// ============================================================
// Multi-MT5 Trade Copier - Shared DTO contracts
// Used by engine, simulator, API routes and frontend.
// ============================================================

export type TerminalStatus = 'connected' | 'connecting' | 'disconnected' | 'reconnecting' | 'error'
export type TerminalRole = 'master' | 'slave' | 'none'

export type LotMode = 'same' | 'fixed' | 'multiplier' | 'balance' | 'risk'
export type SyncPolicy = 'report' | 'autoOpenMissing' | 'autoCloseExtra'
export type EmergencyPolicy = 'halt' | 'halt_close_master' | 'halt_close_all'

export type CopyAction =
  | 'open'
  | 'close'
  | 'partial'
  | 'modify_sltp'
  | 'place_pending'
  | 'cancel_pending'

export type CopyOpStatus = 'pending' | 'sent' | 'executed' | 'failed' | 'skipped' | 'missed'

export interface TerminalDTO {
  id: string
  name: string
  broker: string
  server: string
  accountNumber: string
  currency: string
  exePath: string
  simulated: boolean
  role: TerminalRole
  enabled: boolean
  paused: boolean
  status: TerminalStatus
  autoReconnect: boolean
  lastSeen: number
  leverage: number
  balance: number
  equity: number
  floatingPL: number
  freeMargin: number
  marginLevel: number
  closedToday: number
  reconnectCount: number
  openPositionsCount: number
  pendingCount: number
  settings?: SlaveSettingsDTO | null
}

export interface SlaveSettingsDTO {
  terminalId: string
  lotMode: LotMode
  fixedLot: number
  multiplier: number
  balanceRatioCap: number
  riskPercent: number
  copySL: boolean
  copyTP: boolean
  copyModifications: boolean
  copyPartialClose: boolean
  copyPending: boolean
  closeOnMasterClose: boolean
  maxSpreadPoints: number
  maxLot: number
  maxPositions: number
  slippagePoints: number
  buyEnabled: boolean
  sellEnabled: boolean
  symbolWhitelist: string
  symbolBlacklist: string
  symbolMapping: string
  syncPolicy: SyncPolicy
  rejectProbability: number
  baseLatencyMs: number
  jitterMs: number
}

export interface PositionDTO {
  id: string
  terminalId: string
  terminalName: string
  terminalRole: TerminalRole
  ticket: string
  symbol: string
  side: 'buy' | 'sell'
  kind: 'position' | 'pending'
  pendingType: string
  volume: number
  openPrice: number
  currentPrice: number
  sl: number
  tp: number
  profit: number
  openTime: number
  masterTicket: string
  copiedByEngine: boolean
}

export interface ClosedTradeDTO {
  id: string
  terminalId: string
  terminalName: string
  terminalRole: TerminalRole
  ticket: string
  symbol: string
  side: 'buy' | 'sell'
  kind: string
  volume: number
  openPrice: number
  closePrice: number
  sl: number
  tp: number
  profit: number
  openTime: number
  closeTime: number
  closeReason: string
  masterTicket: string
}

export interface CopyOperationDTO {
  id: string
  masterTerminalId: string
  slaveTerminalId: string
  slaveName: string
  masterTicket: string
  slaveTicket: string
  action: CopyAction
  eventKey: string
  status: CopyOpStatus
  failReason: string
  failCode: string
  detectedAt: number
  sentAt: number
  ackAt: number
  doneAt: number
  latencyMs: number
  totalMs: number
}

export interface MasterTradeRelationDTO {
  masterTicket: string
  symbol: string
  side: 'buy' | 'sell'
  volume: number
  openPrice: number
  sl: number
  tp: number
  openTime: number
  profit: number
  isOpen: boolean
  copies: CopyOperationDTO[]
}

export interface LogDTO {
  id: string
  ts: number
  level: 'info' | 'success' | 'warn' | 'error'
  category: string
  terminalId: string
  terminalName: string
  message: string
  details: string
}

export interface LatencyStatsDTO {
  current: number
  average: number
  min: number
  max: number
  samples: number
  successfulCopies: number
  failedCopies: number
  missedEvents: number
  reconnectionEvents: number
  lastEventAt: number
  recent: { ts: number; totalMs: number; ok: boolean }[]
  perSlave: { terminalId: string; name: string; avgMs: number; count: number; ok: number; failed: number }[]
}

export interface EngineStatsDTO {
  engineRunning: boolean
  copyEnabled: boolean
  emergencyPolicy: EmergencyPolicy
  masterStatus: TerminalStatus | 'none'
  masterName: string
  totalTerminals: number
  connectedTerminals: number
  activeSlaves: number
  openPositionsTotal: number
  pendingTotal: number
  copiedToday: number
  failedToday: number
  lastEventAt: number
  bootedAt: number
  now: number
}

export interface SnapshotDTO {
  stats: EngineStatsDTO
  terminals: TerminalDTO[]
  masterRelations: MasterTradeRelationDTO[]
  latency: LatencyStatsDTO
}

export interface AppSettingsDTO {
  engineRunning: boolean
  copyEnabled: boolean
  emergencyPolicy: EmergencyPolicy
  syncOnStart: SyncPolicy
  masterAutoTrade: boolean
  autoTradeIntervalMs: number
  defaultRejectProbability: number
}

export interface TestResultDTO {
  id: string
  runId: string
  testKey: string
  title: string
  status: 'running' | 'pass' | 'fail'
  durationMs: number
  detail: string
  latencyMs: number
  ts: number
}

export interface TestRunDTO {
  id: string
  startedAt: number
  finishedAt: number
  status: 'running' | 'done' | 'failed'
  passed: number
  failed: number
  avgLatencyMs: number
}

// ---------- Terminal-side command/event contracts ----------
// On Windows these travel over local TCP between the central engine
// and the MQL5 Expert Advisor attached to each terminal.
// In this sandbox the SimulatorHub implements the same interface.

/** Abstraction over one terminal connection (simulator now, EA bridge on Windows). */
export interface TerminalLink {
  isConnected(): boolean
  send(cmd: TerminalCommand): Promise<CommandResult>
  getSymbolSpec(symbol: string): SymbolSpec | null
}

export interface TerminalCommand {
  kind: 'open' | 'close' | 'partial' | 'modify_sltp' | 'place_pending' | 'cancel_pending'
  ticket?: string // for close/partial/modify/cancel
  symbol: string
  side?: 'buy' | 'sell'
  volume?: number // target volume for open; closed volume for partial
  price?: number // entry for pending orders
  sl?: number
  tp?: number
  pendingType?: string
  masterTicket?: string // traceability, stored in order comment
  eventKey?: string // idempotency key from engine
}

export interface CommandResult {
  ok: boolean
  ticket?: string
  price?: number
  error?: string
  code?: string // broker_reject | invalid_volume | unknown_symbol | market_closed | offline | ...
  at: number // epoch ms ack time
}

export interface TradeEvent {
  type:
    | 'position_opened'
    | 'position_closed'
    | 'partial_closed'
    | 'sltp_modified'
    | 'pending_placed'
    | 'pending_cancelled'
    | 'pending_filled'
  ticket: string
  symbol: string
  side?: 'buy' | 'sell'
  volume: number
  closedVolume?: number
  price?: number
  sl?: number
  tp?: number
  closeReason?: string
  pendingType?: string
  ts: number
}

export interface SymbolSpec {
  symbol: string
  volumeMin: number
  volumeMax: number
  volumeStep: number
  spreadPoints: number // current spread in points
  contractSize: number
  tickValue: number
  tickSize: number
  digits: number
  point: number
}
