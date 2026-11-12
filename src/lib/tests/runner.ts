// ============================================================
// Acceptance Test Runner - executes the 17 mandatory scenario
// tests (requirements section 15) against the REAL engine +
// simulator, with real assertions and real measured latencies.
//
// Results are written to TestRun/TestResult rows as the run
// progresses so the dashboard can poll live progress.
// ============================================================

import { db } from '@/lib/db'
import { getEngine } from '@/lib/engine'
import { getSimulator } from '@/lib/simulator'
import { logEvent } from '@/lib/engine/logger'
import { round2 } from '@/lib/engine/lotcalc'

const g = globalThis as unknown as { __copierTestRunning?: string | null }

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms))
}

async function waitFor(
  desc: string,
  predicate: () => Promise<boolean> | boolean,
  timeoutMs = 10000,
  intervalMs = 250,
): Promise<boolean> {
  const start = Date.now()
  while (Date.now() - start < timeoutMs) {
    try {
      if (await predicate()) return true
    } catch {
      // retry
    }
    await sleep(intervalMs)
  }
  await logEvent({
    level: 'warn',
    category: 'test',
    message: `waitFor timeout: ${desc} (${timeoutMs}ms)`,
  }).catch(() => undefined)
  return false
}

interface RunCtx {
  runId: string
}

async function record(ctx: RunCtx, key: string, title: string, fn: () => Promise<string>): Promise<void> {
  const ts = Date.now()
  const row = await db.testResult.create({
    data: { runId: ctx.runId, testKey: key, title, status: 'running', ts },
  })
  const started = Date.now()
  try {
    const detail = await fn()
    const durationMs = Date.now() - started
    await db.testResult.update({
      where: { id: row.id },
      data: { status: 'pass', detail, durationMs, ts: Date.now() },
    })
  } catch (e) {
    const durationMs = Date.now() - started
    const message = e instanceof Error ? e.message : String(e)
    await db.testResult.update({
      where: { id: row.id },
      data: { status: 'fail', detail: message, durationMs, ts: Date.now() },
    })
  }
}

function assert(cond: unknown, message: string): asserts cond {
  if (!cond) throw new Error(message)
}

/** Wait until at least `expectSlaves` slaves have an executed 'open' copy op. */
async function waitAllCopies(ticket: string, expectSlaves: number, timeoutMs = 12000): Promise<number> {
  let executed = 0
  await waitFor(
    `copies for ${ticket}`,
    async () => {
      const ops = await db.copyOperation.findMany({
        where: { masterTicket: ticket, action: 'open' },
      })
      executed = ops.filter((o) => o.status === 'executed').length
      return executed >= expectSlaves
    },
    timeoutMs,
  )
  return executed
}

// ------------------------------------------------------------
// The 17 acceptance tests
// ------------------------------------------------------------

export async function runAcceptanceSuite(runId: string): Promise<void> {
  const ctx: RunCtx = { runId }
  const engine = getEngine()
  await engine.ensureStarted()
  const sim = getSimulator()

  await db.testRun.update({ where: { id: runId }, data: { status: 'running' } })
  await logEvent({
    level: 'info',
    category: 'test',
    message: 'Acceptance suite started (17 tests)',
  }).catch(() => undefined)

  // deterministic environment
  const prevSettings = await db.appSettings.findUnique({ where: { id: 'singleton' } })
  await engine.updateAppSettings({ masterAutoTrade: false })
  await sim.resetAll()
  await sleep(1200)

  let savedBetaLotMode = 'same'
  let savedBetaMultiplier = 1
  let offlineSlaveId = ''
  let offlineMasterTicket = ''

  try {
    const terminals = await db.terminal.findMany({ include: { slaveSettings: true } })
    const master = terminals.find((t) => t.role === 'master')
    const slaves = terminals.filter((t) => t.role === 'slave')
    assert(master, 'No master terminal exists')
    assert(slaves.length >= 2, `Need at least 2 slaves, found ${slaves.length}`)

    for (const t of terminals) {
      await sim.setTerminalStatus(t.id, 'connected')
    }
    await waitFor('all terminals connected', async () => {
      const rows = await db.terminal.findMany({ select: { status: true } })
      return rows.every((r) => r.status === 'connected')
    })

    // --- T01: 3+ terminals connected simultaneously
    await record(ctx, 'T01', 'اتصال هم‌زمان حداقل ۳ ترمینال MT5', async () => {
      const rows = await db.terminal.findMany({ select: { status: true } })
      const connected = rows.filter((r) => r.status === 'connected').length
      assert(rows.length >= 3, `Only ${rows.length} terminals registered`)
      assert(connected >= 3, `Only ${connected} terminals connected`)
      return `${rows.length} ترمینال ثبت شد و ${connected} ترمینال متصل است`
    })

    // --- T02: exactly one master, rest slaves
    await record(ctx, 'T02', 'انتخاب یک Master و دو Slave', async () => {
      const rows = await db.terminal.findMany({ select: { role: true, name: true } })
      const masters = rows.filter((r) => r.role === 'master')
      const slv = rows.filter((r) => r.role === 'slave')
      assert(masters.length === 1, `Expected exactly 1 master, found ${masters.length}`)
      assert(slv.length >= 2, `Expected at least 2 slaves, found ${slv.length}`)
      return `Master: ${masters[0].name} | Slaves: ${slv.map((s) => s.name).join(', ')}`
    })

    // --- T03: Buy on master copied to all slaves
    await record(ctx, 'T03', 'کپی Buy از Master در تمام Slaveها', async () => {
      const r = await sim.masterOpenTrade({ symbol: 'EURUSD', side: 'buy', volume: 0.3 })

      const n = await waitAllCopies(r.ticket, slaves.length)
      assert(n >= slaves.length, `Only ${n}/${slaves.length} slaves executed`)
      const ops = await db.copyOperation.findMany({ where: { masterTicket: r.ticket, action: 'open' } })
      const lat = ops.filter((o) => o.status === 'executed').map((o) => o.latencyMs)
      const avg = Math.round(lat.reduce((a, b) => a + b, 0) / Math.max(1, lat.length))
      return `EURUSD Buy 0.30 در ${n} اسلیو اجرا شد | میانگین تأخیر: ${avg}ms`
    })

    // --- T04: Sell on master copied
    await record(ctx, 'T04', 'کپی Sell از Master در تمام Slaveها', async () => {
      const r = await sim.masterOpenTrade({ symbol: 'GBPUSD', side: 'sell', volume: 0.2 })

      const n = await waitAllCopies(r.ticket, slaves.length)
      assert(n >= slaves.length, `Only ${n}/${slaves.length} slaves executed`)
      const slavePos = await db.position.findMany({
        where: { masterTicket: r.ticket, side: 'sell' },
      })
      assert(slavePos.length >= slaves.length, 'Sell side missing on some slaves')
      return `GBPUSD Sell 0.20 در ${n} اسلیو اجرا شد`
    })

    // --- T05: full close on master closes slaves
    await record(ctx, 'T05', 'بستن کامل معامله Master و بسته شدن Slaveها', async () => {
      const r3 = await sim.masterOpenTrade({ symbol: 'USDJPY', side: 'buy', volume: 0.1 })

      await waitAllCopies(r3.ticket, slaves.length)
      const closeRes = await sim.masterCloseTrade(r3.ticket)

      const ok = await waitFor('slave closed trades', async () => {
        const closed = await db.closedTrade.count({
          where: { masterTicket: r3.ticket, kind: 'position' },
        })
        return closed >= slaves.length
      })
      assert(ok, 'Slave positions were not all closed')
      const stillOpen = await db.position.count({ where: { masterTicket: r3.ticket } })
      assert(stillOpen === 0, 'Copied positions still open on slaves')
      return `بستن کامل: ${slaves.length} اسلیو همگام بسته شدند`
    })

    // --- T06: partial close
    await record(ctx, 'T06', 'کپی Partial Close', async () => {
      const r = await sim.masterOpenTrade({ symbol: 'AUDUSD', side: 'buy', volume: 0.4 })

      await waitAllCopies(r.ticket, slaves.length)
      const pc = await sim.masterPartialClose(r.ticket, 0.5)

      const ok = await waitFor('partial propagated', async () => {
        const pos = await db.position.findMany({ where: { masterTicket: r.ticket } })
        return pos.length >= slaves.length && pos.every((p) => p.volume <= 0.201)
      })
      assert(ok, 'Slave volumes were not reduced after partial close')
      return 'نصف حجم در تمام اسلیوها بسته شد (حجم باقیمانده ~0.20)'
    })

    // --- T07: SL/TP modification propagation
    await record(ctx, 'T07', 'کپی تغییرات Stop Loss / Take Profit', async () => {
      const open = await db.position.findFirst({
        where: { terminalId: master!.id, symbol: 'AUDUSD', kind: 'position' },
      })
      assert(open, 'No AUDUSD master position to modify')
      const mod = await sim.masterModifySLTP(open!.ticket)

      const masterRow = await db.position.findUnique({
        where: { terminalId_ticket: { terminalId: master!.id, ticket: open!.ticket } },
      })
      assert(masterRow, 'Master position row missing')
      const ok = await waitFor('sltp propagated', async () => {
        const copies = await db.position.findMany({ where: { masterTicket: open!.ticket } })
        return (
          copies.length >= slaves.length &&
          copies.every(
            (c) => Math.abs(c.sl - masterRow!.sl) < 1e-6 && Math.abs(c.tp - masterRow!.tp) < 1e-6,
          )
        )
      })
      assert(ok, 'SL/TP not updated on all slaves')
      return `SL=${masterRow!.sl} TP=${masterRow!.tp} در تمام اسلیوها اعمال شد`
    })

    // --- T08: multiple sequential trades
    let seqTicket = ''
    await record(ctx, 'T08', 'کپی چند معامله متوالی بدون جاافتادگی', async () => {
      const tickets: string[] = []
      for (let i = 0; i < 3; i++) {
        const r = await sim.masterOpenTrade({ symbol: i % 2 === 0 ? 'EURUSD' : 'XAUUSD', volume: 0.1 })

        tickets.push(r.ticket)
      }
      for (const tk of tickets) {
        const n = await waitAllCopies(tk, slaves.length)
        assert(n >= slaves.length, `Trade ${tk}: only ${n}/${slaves.length} executed`)
      }
      seqTicket = tickets[0]
      return `۳ معامله پشت‌سرهم در ${slaves.length} اسلیو کپی شد`
    })

    // --- T09: duplicate event does not duplicate orders
    await record(ctx, 'T09', 'جلوگیری از معامله تکراری (Idempotency)', async () => {
      const ticket = seqTicket
      assert(ticket, 'No ticket available for duplicate test')
      const masterPos = await db.position.findUnique({
        where: { terminalId_ticket: { terminalId: master!.id, ticket } },
      })
      if (!masterPos) {
        // position may have been closed by SL/TP during the run; use any open one
        const anyOpen = await db.position.findFirst({ where: { terminalId: master!.id } })
        assert(anyOpen, 'No open master position for duplicate test')
        const beforeSlave = await db.position.count({ where: { masterTicket: anyOpen!.ticket } })
        const beforeOps = await db.copyOperation.count({
          where: { masterTicket: anyOpen!.ticket, action: 'open' },
        })
        await engine.onTradeEvent(master!.id, {
          type: 'position_opened',
          ticket: anyOpen!.ticket,
          symbol: anyOpen!.symbol,
          side: anyOpen!.side as 'buy' | 'sell',
          volume: anyOpen!.volume,
          price: anyOpen!.openPrice,
          sl: anyOpen!.sl,
          tp: anyOpen!.tp,
          ts: Date.now(),
        })
        await sleep(1500)
        const afterSlave = await db.position.count({ where: { masterTicket: anyOpen!.ticket } })
        const afterOps = await db.copyOperation.count({
          where: { masterTicket: anyOpen!.ticket, action: 'open' },
        })
        assert(
          afterSlave === beforeSlave && afterOps === beforeOps,
          `Duplicate detected! positions ${beforeSlave}->${afterSlave}, ops ${beforeOps}->${afterOps}`,
        )
        return `رویداد تکراری نادیده گرفته شد (positions=${afterSlave}, ops=${afterOps})`
      }
      const beforeSlave = await db.position.count({ where: { masterTicket: ticket } })
      const beforeOps = await db.copyOperation.count({ where: { masterTicket: ticket, action: 'open' } })
      await engine.onTradeEvent(master!.id, {
        type: 'position_opened',
        ticket,
        symbol: masterPos.symbol,
        side: masterPos.side as 'buy' | 'sell',
        volume: masterPos.volume,
        price: masterPos.openPrice,
        sl: masterPos.sl,
        tp: masterPos.tp,
        ts: Date.now(),
      })
      await sleep(1500)
      const afterSlave = await db.position.count({ where: { masterTicket: ticket } })
      const afterOps = await db.copyOperation.count({ where: { masterTicket: ticket, action: 'open' } })
      assert(
        afterSlave === beforeSlave && afterOps === beforeOps,
        `Duplicate detected! positions ${beforeSlave}->${afterSlave}, ops ${beforeOps}->${afterOps}`,
      )
      return `رویداد تکراری نادیده گرفته شد (positions=${afterSlave}, ops=${afterOps})`
    })

    // --- T10: slave offline during a master trade
    offlineSlaveId = slaves[slaves.length - 1].id
    await record(ctx, 'T10', 'قطع اتصال Slave هنگام باز شدن معامله', async () => {
      await sim.setTerminalStatus(offlineSlaveId, 'disconnected')
      const ok = await waitFor('slave marked disconnected', async () => {
        const row = await db.terminal.findUnique({ where: { id: offlineSlaveId } })
        return row?.status === 'disconnected'
      })
      assert(ok, 'Slave was not marked disconnected')
      const r = await sim.masterOpenTrade({ symbol: 'XAUUSD', side: 'buy', volume: 0.5 })

      offlineMasterTicket = r.ticket
      await waitAllCopies(r.ticket, slaves.length - 1)
      const op = await db.copyOperation.findFirst({
        where: { masterTicket: r.ticket, slaveTerminalId: offlineSlaveId, action: 'open' },
      })
      assert(op, 'No copy operation recorded for offline slave')
      assert(
        op!.status === 'failed' || op!.status === 'missed' || op!.status === 'skipped',
        `Offline slave op should not be executed (got ${op!.status})`,
      )
      const pos = await db.position.count({
        where: { masterTicket: r.ticket, terminalId: offlineSlaveId },
      })
      assert(pos === 0, 'Offline slave unexpectedly opened a position')
      return `اسلیو آفلاین: status=${op!.status} code=${op!.failCode || '-'} | بدون پوزیشن`
    })

    // --- T11: reconnect + synchronization
    await record(ctx, 'T11', 'اتصال مجدد و همگام‌سازی معاملات جاافتاده', async () => {
      await sim.setTerminalStatus(offlineSlaveId, 'connected')
      const ok = await waitFor('slave reconnected', async () => {
        const row = await db.terminal.findUnique({ where: { id: offlineSlaveId } })
        return row?.status === 'connected'
      })
      assert(ok, 'Slave did not reconnect')
      const res = await engine.syncOpenMissing(offlineSlaveId)
      const pos = await db.position.count({
        where: { masterTicket: offlineMasterTicket, terminalId: offlineSlaveId },
      })
      assert(pos >= 1, 'Missing trade was not opened after sync')
      return `همگام‌سازی انجام شد: ${res.opened} معامله جاافتاده باز شد`
    })

    // --- T12: engine restart keeps state
    await record(ctx, 'T12', 'بستن و اجرای مجدد نرم‌افزار (Restart موتور)', async () => {
      const termBefore = await db.terminal.count()
      const posBefore = await db.position.count()
      await engine.restart()
      assert(engine.isRunning(), 'Engine not running after restart')
      const termAfter = await db.terminal.count()
      const posAfter = await db.position.count()
      assert(termBefore === termAfter, `Terminals lost on restart (${termBefore}->${termAfter})`)
      assert(posAfter >= Math.floor(posBefore * 0.9), `Positions lost on restart (${posBefore}->${posAfter})`)
      const ok = await waitFor('terminals reconnected after restart', async () => {
        const rows = await db.terminal.findMany({ select: { status: true } })
        return rows.filter((r) => r.status === 'connected').length >= 3
      })
      assert(ok, 'Terminals did not reconnect after restart')
      return `ری‌استارت کامل شد؛ ${termAfter} ترمینال و ${posAfter} پوزیشن حفظ شد`
    })

    // --- T13: no duplicate orders after restart
    await record(ctx, 'T13', 'عدم ایجاد سفارش تکراری پس از Restart', async () => {
      const posBefore = await db.position.count()
      const opsBefore = await db.copyOperation.count()
      await sleep(2500) // let any (wrong) replay logic fire; SL/TP closes during this window are legitimate
      const posAfter = await db.position.count()
      const opsAfter = await db.copyOperation.count()
      // duplicates would ADD positions/ops; legitimate market closes only reduce them
      assert(
        posAfter <= posBefore,
        `Positions INCREASED after restart (duplicates!): ${posBefore}->${posAfter}`,
      )
      assert(opsAfter === opsBefore, `CopyOperation ledger changed after restart: ${opsBefore}->${opsAfter}`)
      return `پس از Restart هیچ سفارش تکراری ایجاد نشد (pos=${posAfter}<=${posBefore}, ops=${opsAfter})`
    })

    // --- T14: symbol mapping + volume multiplier
    await record(ctx, 'T14', 'اختلاف نام نماد و حجم بین حساب‌ها (Mapping/Multiplier)', async () => {
      const beta = slaves.find((s) => (s.slaveSettings?.symbolMapping ?? '').length > 0) ?? slaves[0]
      const betaSettings = await db.slaveSettings.findUnique({ where: { terminalId: beta.id } })
      savedBetaLotMode = betaSettings?.lotMode ?? 'same'
      savedBetaMultiplier = betaSettings?.multiplier ?? 1
      await engine.updateSlaveSettings(beta.id, { lotMode: 'multiplier', multiplier: 0.5 })
      const r = await sim.masterOpenTrade({ symbol: 'XAUUSD', side: 'buy', volume: 0.5 })

      const n = await waitAllCopies(r.ticket, slaves.length - 1)
      assert(n >= slaves.length - 1, `Copies: ${n}/${slaves.length}`)
      const betaPos = await db.position.findFirst({
        where: { masterTicket: r.ticket, terminalId: beta.id },
      })
      assert(betaPos, 'Beta did not receive the trade')
      const hasMapping = (beta.slaveSettings?.symbolMapping ?? '').includes('XAUUSD')
      if (hasMapping) {
        assert(betaPos!.symbol === 'GOLD', `Mapping failed: expected GOLD, got ${betaPos!.symbol}`)
      }
      assert(
        Math.abs(betaPos!.volume - 0.25) < 0.001,
        `Multiplier failed: expected 0.25, got ${betaPos!.volume}`,
      )
      await engine.updateSlaveSettings(beta.id, {
        lotMode: savedBetaLotMode as SlaveLotMode,
        multiplier: savedBetaMultiplier,
      })
      return `نماد: XAUUSD -> ${betaPos!.symbol} | حجم: 0.50 x 0.5 = ${betaPos!.volume}`
    })

    // --- T15: broker rejection handling + isolation
    await record(ctx, 'T15', 'رفتار سیستم هنگام رد شدن سفارش توسط بروکر', async () => {
      const gamma = slaves.find((s) => s.id !== offlineSlaveId) ?? slaves[0]
      await sim.setRejectProbability(gamma.id, 1)
      const r = await sim.masterOpenTrade({ symbol: 'AUDUSD', side: 'sell', volume: 0.2 })

      let op: { status: string; failCode: string; failReason: string } | null = null
      await waitFor('reject recorded', async () => {
        const row = await db.copyOperation.findFirst({
          where: { masterTicket: r.ticket, slaveTerminalId: gamma.id, action: 'open' },
        })
        if (row && row.status !== 'sent' && row.status !== 'pending') {
          op = { status: row.status, failCode: row.failCode, failReason: row.failReason }
        }
        return op !== null
      })
      assert(op, 'No terminal op recorded for rejecting slave')
      await sim.setRejectProbability(gamma.id, 0.03)
      const o = op as unknown as { status: string; failCode: string; failReason: string }
      assert(o.status === 'failed', `Expected failed, got ${o.status}`)
      assert(o.failCode === 'broker_reject', `Expected broker_reject, got ${o.failCode}`)
      const others = await db.copyOperation.count({
        where: { masterTicket: r.ticket, action: 'open', status: 'executed' },
      })
      assert(others >= 1, 'Other slaves were blocked by one failing slave')
      return `رد بروکر ثبت شد (${o.failReason.slice(0, 40)}) | بقیه اسلیوها مستقل اجرا شدند (${others})`
    })

    // --- T16: account metrics coherence
    await record(ctx, 'T16', 'صحت نمایش Balance/Equity و پوزیشن‌ها', async () => {
      await sleep(1500)
      const snap = await engine.getSnapshot()
      assert(snap.terminals.length >= 3, 'Terminals missing in snapshot')
      for (const t of snap.terminals) {
        const expected = t.balance + t.floatingPL
        const diff = Math.abs(t.equity - expected)
        assert(
          diff < Math.max(2, Math.abs(expected) * 0.01),
          `${t.name}: equity ${t.equity} != balance+floating ${round2(expected)} (diff ${round2(diff)})`,
        )
      }
      const totalOpen = await db.position.count({ where: { kind: 'position' } })
      assert(
        Math.abs(snap.stats.openPositionsTotal - totalOpen) <= 1,
        `Open positions mismatch: snapshot ${snap.stats.openPositionsTotal} vs db ${totalOpen}`,
      )
      return `Equity=Balance+Floating برای ${snap.terminals.length} حساب صحیح است | پوزیشن باز: ${snap.stats.openPositionsTotal}`
    })

    // --- T17: real latency measured
    await record(ctx, 'T17', 'اندازه‌گیری تأخیر واقعی کپی', async () => {
      const all = await db.metricEvent.findMany({ where: { action: 'open' } })
      const okSamples = all.filter((m) => m.ok).map((m) => m.totalMs)
      assert(okSamples.length >= 3, `Not enough latency samples (${okSamples.length})`)
      const avg = Math.round(okSamples.reduce((a, b) => a + b, 0) / okSamples.length)
      const min = Math.min(...okSamples)
      const max = Math.max(...okSamples)
      assert(avg > 0 && max >= min, 'Latency statistics invalid')
      const stats = await engine.getLatencyStats()
      assert(stats.average > 0, 'Latency stats endpoint invalid')
      return `${okSamples.length} نمونه واقعی | avg=${avg}ms min=${min}ms max=${max}ms`
    })

    const results = await db.testResult.findMany({ where: { runId } })
    const passed = results.filter((r) => r.status === 'pass').length
    const failed = results.filter((r) => r.status === 'fail').length
    const lat = await db.metricEvent.findMany({ where: { ok: true, action: 'open' } })
    const avgLatency = lat.length
      ? Math.round(lat.reduce((a, m) => a + m.totalMs, 0) / lat.length)
      : 0
    await db.testRun.update({
      where: { id: runId },
      data: { status: 'done', finishedAt: Date.now(), passed, failed, avgLatencyMs: avgLatency },
    })
    await logEvent({
      level: failed === 0 ? 'success' : 'warn',
      category: 'test',
      message: `Acceptance suite finished: ${passed} passed, ${failed} failed (avg copy latency ${avgLatency}ms)`,
    }).catch(() => undefined)
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e)
    await db.testRun
      .update({
        where: { id: runId },
        data: { status: 'failed', finishedAt: Date.now(), log: message },
      })
      .catch(() => undefined)
    await logEvent({
      level: 'error',
      category: 'test',
      message: `Acceptance suite crashed: ${message}`,
    }).catch(() => undefined)
  } finally {
    try {
      const beta = await db.terminal.findFirst({ where: { name: 'MT5-Beta' } })
      if (beta) {
        await engine.updateSlaveSettings(beta.id, {
          lotMode: savedBetaLotMode as SlaveLotMode,
          multiplier: savedBetaMultiplier,
        })
      }
      if (offlineSlaveId) await sim.setRejectProbability(offlineSlaveId, 0.03)
      await engine.updateAppSettings({ masterAutoTrade: prevSettings?.masterAutoTrade ?? true })
    } catch {
      // ignore
    }
    g.__copierTestRunning = null
  }
}

type SlaveLotMode = 'same' | 'fixed' | 'multiplier' | 'balance' | 'risk'

export async function startAcceptanceRun(): Promise<{ runId: string }> {
  if (g.__copierTestRunning) return { runId: g.__copierTestRunning }
  const run = await db.testRun.create({
    data: { startedAt: Date.now(), status: 'running' },
  })
  g.__copierTestRunning = run.id
  void runAcceptanceSuite(run.id).catch(() => {
    g.__copierTestRunning = null
  })
  return { runId: run.id }
}
