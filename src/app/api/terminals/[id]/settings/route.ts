import { readyEngine, ok, fail, errorMessage } from '../../../_helpers'
import type { SlaveSettingsDTO } from '@/lib/types'

export const dynamic = 'force-dynamic'

export async function PUT(req: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const engine = await readyEngine()
    const { id } = await params
    const body = (await req.json()) as Partial<SlaveSettingsDTO>
    const saved = await engine.updateSlaveSettings(id, body)
    return ok(saved)
  } catch (e) {
    return fail(errorMessage(e), 500)
  }
}
