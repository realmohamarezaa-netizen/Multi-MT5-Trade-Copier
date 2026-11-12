import { db } from '@/lib/db'
import { readyEngine, ok, fail, errorMessage } from '../_helpers'
import type { AppSettingsDTO } from '@/lib/types'

export const dynamic = 'force-dynamic'

async function readSettings(): Promise<AppSettingsDTO> {
  const engine = await readyEngine()
  const row = await db.appSettings.findUnique({ where: { id: 'singleton' } })
  if (!row) throw new Error('App settings missing')
  return {
    engineRunning: row.engineRunning,
    copyEnabled: row.copyEnabled,
    emergencyPolicy: row.emergencyPolicy as AppSettingsDTO['emergencyPolicy'],
    syncOnStart: row.syncOnStart as AppSettingsDTO['syncOnStart'],
    masterAutoTrade: row.masterAutoTrade,
    autoTradeIntervalMs: row.autoTradeIntervalMs,
    defaultRejectProbability: row.defaultRejectProbability,
  }
}

export async function GET() {
  try {
    return ok(await readSettings())
  } catch (e) {
    return fail(errorMessage(e), 500)
  }
}

export async function PUT(req: Request) {
  try {
    const engine = await readyEngine()
    const body = (await req.json()) as Partial<AppSettingsDTO>
    const saved = await engine.updateAppSettings(body)
    return ok(saved)
  } catch (e) {
    return fail(errorMessage(e), 500)
  }
}
