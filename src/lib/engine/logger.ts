// ============================================================
// Structured event logging for the copier engine.
// Writes LogEntry rows (SQLite) and keeps an in-memory ring
// buffer (last 500) for fast snapshot building.
// Logging must NEVER throw into business logic.
// ============================================================

import { db } from '@/lib/db'
import type { LogDTO } from '@/lib/types'

export type LogLevel = 'info' | 'success' | 'warn' | 'error'
export type LogCategory = 'connection' | 'trade' | 'copy' | 'engine' | 'sync' | 'settings' | 'test'

export interface LogEventInput {
  level: LogLevel
  category: LogCategory
  terminalId?: string
  terminalName?: string
  message: string
  details?: string
}

const RING_MAX = 500

// Ring buffer survives hot reloads via globalThis (same pattern as db.ts).
const g = globalThis as unknown as { __copierLogRing?: LogDTO[] }

function ring(): LogDTO[] {
  if (!g.__copierLogRing) g.__copierLogRing = []
  return g.__copierLogRing
}

function syntheticId(ts: number): string {
  return `log_${ts.toString(36)}_${Math.random().toString(36).slice(2, 8)}`
}

export async function logEvent(entry: LogEventInput): Promise<void> {
  const ts = Date.now()
  const data = {
    ts,
    level: entry.level,
    category: entry.category,
    terminalId: entry.terminalId ?? '',
    terminalName: entry.terminalName ?? '',
    message: entry.message,
    details: entry.details ?? '',
  }
  let id = syntheticId(ts)
  try {
    const row = await db.logEntry.create({ data })
    id = row.id
  } catch {
    // Database unavailable: keep the ring buffer working, never throw.
  }
  const dto: LogDTO = { id, ...data }
  const r = ring()
  r.push(dto)
  if (r.length > RING_MAX) r.splice(0, r.length - RING_MAX)
}

/**
 * Returns the most recent `limit` entries, newest first.
 * (Chronological order is available by reversing the result.)
 */
export function getRecentLogs(limit = 200): LogDTO[] {
  const r = ring()
  return r.slice(-Math.max(1, limit)).reverse()
}

/** Fire-and-forget wrapper for contexts where logging must not delay the caller. */
export function logEventSafe(entry: LogEventInput): void {
  void logEvent(entry).catch(() => undefined)
}
