import { db } from '@/lib/db'
import { readyEngine, ok, fail, errorMessage } from '../../_helpers'
import type { TestResultDTO, TestRunDTO } from '@/lib/types'

export const dynamic = 'force-dynamic'

export async function GET(_req: Request, { params }: { params: Promise<{ runId: string }> }) {
  try {
    await readyEngine()
    const { runId } = await params
    const run = await db.testRun.findUnique({ where: { id: runId } })
    if (!run) return fail('Test run not found', 404)
    const results = await db.testResult.findMany({
      where: { runId },
      orderBy: { ts: 'asc' },
    })
    const runDTO: TestRunDTO = {
      id: run.id,
      startedAt: run.startedAt,
      finishedAt: run.finishedAt,
      status: run.status as TestRunDTO['status'],
      passed: run.passed,
      failed: run.failed,
      avgLatencyMs: run.avgLatencyMs,
    }
    const resultDTOs: TestResultDTO[] = results.map((r) => ({
      id: r.id,
      runId: r.runId,
      testKey: r.testKey,
      title: r.title,
      status: r.status as TestResultDTO['status'],
      durationMs: r.durationMs,
      detail: r.detail,
      latencyMs: r.latencyMs,
      ts: r.ts,
    }))
    return ok({ run: runDTO, results: resultDTOs })
  } catch (e) {
    return fail(errorMessage(e), 500)
  }
}
