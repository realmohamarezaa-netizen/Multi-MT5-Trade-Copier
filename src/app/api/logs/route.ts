import { readyEngine, ok, fail, errorMessage } from '../_helpers'

export const dynamic = 'force-dynamic'

export async function GET(req: Request) {
  try {
    const engine = await readyEngine()
    const url = new URL(req.url)
    const level = url.searchParams.get('level') ?? undefined
    const category = url.searchParams.get('category') ?? undefined
    const terminalId = url.searchParams.get('terminalId') ?? undefined
    const q = url.searchParams.get('q') ?? undefined
    const limit = Number(url.searchParams.get('limit') ?? 200)
    const logs = await engine.getLogs({ level, category, terminalId, q, limit })
    return ok(logs)
  } catch (e) {
    return fail(errorMessage(e), 500)
  }
}
