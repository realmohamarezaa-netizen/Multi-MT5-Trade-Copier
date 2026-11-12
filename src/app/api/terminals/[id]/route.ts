import { readyEngine, ok, fail, errorMessage } from '../../_helpers'
import type { TerminalRole } from '@/lib/types'

export const dynamic = 'force-dynamic'

export async function PATCH(req: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const engine = await readyEngine()
    const { id } = await params
    const body = (await req.json()) as { action: string; value?: string | boolean }

    switch (body.action) {
      case 'connect':
        await engine.connectTerminal(id)
        break
      case 'disconnect':
        await engine.disconnectTerminal(id)
        break
      case 'setRole':
        await engine.setRole(id, String(body.value ?? 'none') as TerminalRole)
        break
      case 'enable':
        await engine.setSlaveEnabled(id, true)
        break
      case 'disable':
        await engine.setSlaveEnabled(id, false)
        break
      case 'pause':
        await engine.setSlavePaused(id, true)
        break
      case 'resume':
        await engine.setSlavePaused(id, false)
        break
      case 'autoReconnect':
        await engine.setAutoReconnect(id, Boolean(body.value))
        break
      default:
        return fail(`Unknown action: ${body.action}`, 422)
    }
    const snap = await engine.getSnapshot()
    const terminal = snap.terminals.find((t) => t.id === id)
    if (!terminal) return fail('Terminal not found', 404)
    return ok(terminal)
  } catch (e) {
    return fail(errorMessage(e), 500)
  }
}

export async function DELETE(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const engine = await readyEngine()
    const { id } = await params
    await engine.removeTerminal(id)
    return ok({ ok: true })
  } catch (e) {
    return fail(errorMessage(e), 500)
  }
}
