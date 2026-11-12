import { readyEngine, ok, fail, errorMessage } from '../../_helpers'
import { startAcceptanceRun } from '@/lib/tests/runner'

export const dynamic = 'force-dynamic'

export async function POST() {
  try {
    await readyEngine()
    const { runId } = await startAcceptanceRun()
    return ok({ runId }, 201)
  } catch (e) {
    return fail(errorMessage(e), 500)
  }
}
