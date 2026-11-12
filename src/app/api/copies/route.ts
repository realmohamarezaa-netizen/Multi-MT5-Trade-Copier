import { db } from '@/lib/db'
import { readyEngine, ok, fail, errorMessage } from '../_helpers'

export const dynamic = 'force-dynamic'

export async function GET(req: Request) {
  try {
    const engine = await readyEngine()
    const url = new URL(req.url)
    const masterTicket = url.searchParams.get('masterTicket') ?? undefined
    const limit = Number(url.searchParams.get('limit') ?? 50)
    if (masterTicket) {
      const ops = await engine.getCopyOpsByMasterTicket(masterTicket)
      return ok(ops)
    }
    const rows = await db.copyOperation.findMany({
      orderBy: { detectedAt: 'desc' },
      take: Math.min(200, Math.max(1, limit)),
    })
    const names = await db.terminal.findMany({ select: { id: true, name: true } })
    const nameOf = (id: string) => names.find((n) => n.id === id)?.name ?? id
    return ok(
      rows.map((r) => ({
        id: r.id,
        masterTerminalId: r.masterTerminalId,
        slaveTerminalId: r.slaveTerminalId,
        slaveName: nameOf(r.slaveTerminalId),
        masterTicket: r.masterTicket,
        slaveTicket: r.slaveTicket,
        action: r.action,
        eventKey: r.eventKey,
        status: r.status,
        failReason: r.failReason,
        failCode: r.failCode,
        detectedAt: r.detectedAt,
        sentAt: r.sentAt,
        ackAt: r.ackAt,
        doneAt: r.doneAt,
        latencyMs: r.latencyMs,
        totalMs: r.totalMs,
      })),
    )
  } catch (e) {
    return fail(errorMessage(e), 500)
  }
}
