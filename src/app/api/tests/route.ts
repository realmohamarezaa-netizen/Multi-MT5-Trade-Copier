import { db } from '@/lib/db'
import { readyEngine, ok, fail, errorMessage } from '../_helpers'
import type { TestResultDTO, TestRunDTO } from '@/lib/types'

export const dynamic = 'force-dynamic'

export async function GET() {
  try {
    await readyEngine()
    const runs = await db.testRun.findMany({ orderBy: { startedAt: 'desc' }, take: 10 })
    const latest = runs[0]
      ? await db.testResult.findMany({
          where: { runId: runs[0].id },
          orderBy: { ts: 'asc' },
        })
      : []
    const mapRun = (r: (typeof runs)[number]): TestRunDTO => ({
      id: r.id,
      startedAt: r.startedAt,
      finishedAt: r.finishedAt,
      status: r.status as TestRunDTO['status'],
      passed: r.passed,
      failed: r.failed,
      avgLatencyMs: r.avgLatencyMs,
    })
    const mapResult = (r: (typeof latest)[number]): TestResultDTO => ({
      id: r.id,
      runId: r.runId,
      testKey: r.testKey,
      title: r.title,
      status: r.status as TestResultDTO['status'],
      durationMs: r.durationMs,
      detail: r.detail,
      latencyMs: r.latencyMs,
      ts: r.ts,
    })
    return ok({ runs: runs.map(mapRun), latest: latest.map(mapResult) })
  } catch (e) {
    return fail(errorMessage(e), 500)
  }
}
