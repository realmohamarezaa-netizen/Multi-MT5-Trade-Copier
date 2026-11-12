import { readyEngine, errorMessage } from '../../_helpers'

export const dynamic = 'force-dynamic'

export async function GET(req: Request) {
  try {
    const engine = await readyEngine()
    const url = new URL(req.url)
    const level = url.searchParams.get('level') ?? undefined
    const category = url.searchParams.get('category') ?? undefined
    const terminalId = url.searchParams.get('terminalId') ?? undefined
    const q = url.searchParams.get('q') ?? undefined
    const limit = Number(url.searchParams.get('limit') ?? 2000)
    const logs = await engine.getLogs({ level, category, terminalId, q, limit })
    const header = 'ts,datetime,level,category,terminal,message,details'
    const rows = logs.map((l) => {
      const esc = (s: string) => `"${String(s).replace(/"/g, '""')}"`
      return [
        l.ts,
        new Date(l.ts).toISOString(),
        l.level,
        l.category,
        l.terminalName || l.terminalId,
        esc(l.message),
        esc(l.details),
      ].join(',')
    })
    const csv = '\uFEFF' + [header, ...rows].join('\n')
    return new Response(csv, {
      status: 200,
      headers: {
        'Content-Type': 'text/csv; charset=utf-8',
        'Content-Disposition': `attachment; filename="mt5copier-logs-${Date.now()}.csv"`,
      },
    })
  } catch (e) {
    return new Response(errorMessage(e), { status: 500 })
  }
}
