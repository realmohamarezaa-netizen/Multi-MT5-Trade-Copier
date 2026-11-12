import { readyEngine, ok, fail, errorMessage } from '../_helpers'

export const dynamic = 'force-dynamic'

export async function POST(req: Request) {
  try {
    const engine = await readyEngine()
    const body = (await req.json()) as { slaveId?: string; action?: string }
    if (!body.slaveId || !body.action) return fail('slaveId and action are required', 422)
    if (body.action === 'open_missing') {
      const res = await engine.syncOpenMissing(body.slaveId)
      return ok(res)
    }
    if (body.action === 'close_extra') {
      const res = await engine.syncCloseExtra(body.slaveId)
      return ok(res)
    }
    return fail(`Unknown sync action: ${body.action}`, 422)
  } catch (e) {
    return fail(errorMessage(e), 500)
  }
}
