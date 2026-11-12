import { readyEngine, ok, fail, errorMessage } from '../_helpers'

export const dynamic = 'force-dynamic'

export async function POST(req: Request) {
  try {
    const engine = await readyEngine()
    const body = (await req.json()) as {
      name?: string
      broker?: string
      server?: string
      exePath?: string
    }
    if (!body.name || typeof body.name !== 'string' || body.name.trim().length === 0) {
      return fail('نام ترمینال الزامی است', 422)
    }
    const dto = await engine.addTerminal({
      name: body.name.trim(),
      broker: body.broker?.trim() || undefined,
      server: body.server?.trim() || undefined,
      exePath: body.exePath?.trim() || undefined,
    })
    return ok(dto, 201)
  } catch (e) {
    return fail(errorMessage(e), 500)
  }
}
