import { readyEngine, ok, fail, errorMessage } from '../_helpers'

export const dynamic = 'force-dynamic'

export async function GET(req: Request) {
  try {
    const engine = await readyEngine()
    const url = new URL(req.url)
    const terminalId = url.searchParams.get('terminalId') ?? undefined
    const symbol = url.searchParams.get('symbol') ?? undefined
    const reason = url.searchParams.get('reason') ?? undefined
    const q = url.searchParams.get('q') ?? undefined
    const from = url.searchParams.get('from') ? Number(url.searchParams.get('from')) : undefined
    const to = url.searchParams.get('to') ? Number(url.searchParams.get('to')) + 86_399_000 : undefined
    const limit = Number(url.searchParams.get('limit') ?? 300)
    const trades = await engine.getClosedTrades({ terminalId, symbol, q, from, to, limit })
    const filtered = reason && reason !== 'all' ? trades.filter((t) => t.closeReason === reason) : trades
    return ok(filtered)
  } catch (e) {
    return fail(errorMessage(e), 500)
  }
}
