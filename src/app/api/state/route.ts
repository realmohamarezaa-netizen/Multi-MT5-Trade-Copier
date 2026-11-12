import { readyEngine, ok, fail, errorMessage } from '../_helpers'

export const dynamic = 'force-dynamic'

export async function GET() {
  try {
    const engine = await readyEngine()
    const snap = await engine.getSnapshot()
    return ok(snap)
  } catch (e) {
    return fail(errorMessage(e), 500)
  }
}
