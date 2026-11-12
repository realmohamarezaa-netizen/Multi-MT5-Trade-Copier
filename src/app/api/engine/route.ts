import { readyEngine, ok, fail, errorMessage } from '../_helpers'

export const dynamic = 'force-dynamic'

export async function POST(req: Request) {
  try {
    const engine = await readyEngine()
    const body = (await req.json()) as { action: string }
    switch (body.action) {
      case 'start_copying':
        await engine.startCopying()
        break
      case 'stop_copying':
        await engine.stopCopying()
        break
      case 'emergency_stop':
        await engine.emergencyStop()
        break
      case 'restart':
        await engine.restart()
        break
      default:
        return fail(`Unknown engine action: ${body.action}`, 422)
    }
    return ok({ ok: true })
  } catch (e) {
    return fail(errorMessage(e), 500)
  }
}
