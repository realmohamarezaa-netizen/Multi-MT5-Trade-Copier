import { readyEngine, ok, fail, errorMessage } from '../_helpers'

export const dynamic = 'force-dynamic'

export async function GET(req: Request) {
  try {
    const engine = await readyEngine()
    const url = new URL(req.url)
    const terminalId = url.searchParams.get('terminalId') ?? undefined
    const kindParam = url.searchParams.get('kind')
    const kind = kindParam === 'pending' ? 'pending' : kindParam === 'position' ? 'position' : undefined
    const symbol = url.searchParams.get('symbol') ?? undefined
    const side = url.searchParams.get('side') ?? undefined
    let positions = await engine.getOpenPositions({ terminalId, kind })
    if (symbol) positions = positions.filter((p) => p.symbol.toLowerCase().includes(symbol.toLowerCase()))
    if (side === 'buy' || side === 'sell') positions = positions.filter((p) => p.side === side)
    return ok(positions)
  } catch (e) {
    return fail(errorMessage(e), 500)
  }
}
