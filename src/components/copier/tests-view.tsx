"use client";

import { useEffect, useMemo, useState } from "react";
import { toast } from "sonner";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import {
  Check,
  ClipboardCheck,
  Loader2,
  Play,
  X,
} from "lucide-react";
import { cn } from "@/lib/utils";

import type { TestResultDTO, TestRunDTO } from "@/lib/types";
import { apiPost, errorMessage } from "./api";
import { EmptyState, ErrorBanner, RtlProgress, SectionCard } from "./common";
import { FaDateTime, Mono, fmtLatin } from "./format";
import { usePolling } from "./use-polling";

interface TestsIndex {
  runs: TestRunDTO[];
  latest: TestResultDTO[];
}

const TOTAL_TESTS = 17;

function StatusIcon({ status }: { status: TestResultDTO["status"] }) {
  if (status === "pass") {
    return (
      <span className="inline-flex size-6 items-center justify-center rounded-full border border-emerald-500/30 bg-emerald-500/10">
        <Check className="size-3.5 text-emerald-500" />
      </span>
    );
  }
  if (status === "fail") {
    return (
      <span className="inline-flex size-6 items-center justify-center rounded-full border border-red-500/30 bg-red-500/10">
        <X className="size-3.5 text-red-500" />
      </span>
    );
  }
  return (
    <span className="inline-flex size-6 items-center justify-center">
      <Loader2 className="size-4 animate-spin text-amber-500" />
    </span>
  );
}

export function TestsView() {
  const { data, error, loading, refresh } = usePolling<TestsIndex>("/api/tests", 2500);
  const [runId, setRunId] = useState<string | null>(null);
  const [starting, setStarting] = useState(false);

  const {
    data: runData,
    error: runError,
    refresh: refreshRun,
  } = usePolling<{ run: TestRunDTO; results: TestResultDTO[] }>(
    runId ? `/api/tests/${runId}` : "/api/tests/none",
    1000,
    runId !== null
  );

  const activeRun = runData?.run ?? null;
  const activeResults = runData?.results ?? [];

  // stop polling once the run finishes
  useEffect(() => {
    if (activeRun && activeRun.status !== "running") {
      setRunId(null);
      if (activeRun.status === "failed") {
        toast.error("اجرای تست‌ها با خطا متوقف شد");
      } else {
        toast.success(
          `اجرای تست‌ها تمام شد — ${activeRun.passed.toLocaleString("fa-IR")} موفق`
        );
      }
      refresh();
    }
  }, [activeRun?.status]);  

  const startRun = async () => {
    setStarting(true);
    try {
      const res = await apiPost<{ runId: string }>("/api/tests/run");
      setRunId(res.runId);
      toast.success("اجرای ۱۷ تست پذیرش آغاز شد");
      refreshRun();
    } catch (err) {
      toast.error(errorMessage(err, "شروع اجرای تست‌ها ناموفق بود"));
    } finally {
      setStarting(false);
    }
  };

  const runs = data?.runs ?? [];
  const latest = data?.latest ?? [];

  const displayResults = runId !== null ? activeResults : latest;
  const summary = useMemo(() => {
    const passed = displayResults.filter((r) => r.status === "pass").length;
    const failed = displayResults.filter((r) => r.status === "fail").length;
    const running = displayResults.filter((r) => r.status === "running").length;
    const latencies = displayResults.filter((r) => r.status === "pass" && r.latencyMs > 0);
    const avg =
      latencies.length > 0
        ? latencies.reduce((sum, r) => sum + r.latencyMs, 0) / latencies.length
        : 0;
    const done = passed + failed;
    const denom = displayResults.length > 0 ? displayResults.length : TOTAL_TESTS;
    return { passed, failed, running, avg, progress: (done / denom) * 100, done };
  }, [displayResults]);

  const isRunning = runId !== null;

  return (
    <div className="flex flex-col gap-6">
      <div>
        <h1 className="flex items-center gap-2 text-lg font-bold text-zinc-100">
          <ClipboardCheck className="size-5 text-amber-500" />
          آزمون‌های پذیرش
        </h1>
        <p className="mt-1 text-xs text-zinc-500">
          سناریوهای کامل کپی، خطا و همگام‌سازی روی حساب‌های شبیه‌سازی‌شده
        </p>
      </div>

      {/* run launcher */}
      <SectionCard>
        <div className="flex flex-col items-center gap-4 py-4 text-center">
          <p className="max-w-lg text-sm leading-6 text-zinc-300">
            ۱۷ تست پذیرش، چرخه کامل کپی، partial close، pending، فیلترها، توقف اضطراری و همگام‌سازی
            را یک‌جا اجرا می‌کند.
          </p>
          <Button
            onClick={startRun}
            disabled={starting || isRunning}
            size="lg"
            className="h-12 gap-2 px-6 text-base"
          >
            {starting || isRunning ? (
              <>
                <Loader2 className="size-5 animate-spin" />
                در حال اجرا...
              </>
            ) : (
              <>
                <Play className="size-5" />
                اجرای ۱۷ تست پذیرش
              </>
            )}
          </Button>
          <p className="text-[11px] text-zinc-600">
            تست‌ها روی حساب‌های شبیه‌سازی‌شده اجرا می‌شوند؛ روی حساب واقعی اثری ندارد.
          </p>
          {isRunning ? (
            <div className="w-full max-w-md pt-2">
              <RtlProgress value={summary.progress} />
              <p className="mt-2 text-xs text-zinc-500">
                {summary.done.toLocaleString("fa-IR")} از {TOTAL_TESTS.toLocaleString("fa-IR")} تست
                تکمیل شد
              </p>
            </div>
          ) : null}
        </div>
      </SectionCard>

      {/* summary */}
      {displayResults.length > 0 ? (
        <div className="grid grid-cols-2 gap-4 md:grid-cols-4">
          <div className="flex flex-col gap-1.5 rounded-xl border border-zinc-800 bg-zinc-900/60 p-4">
            <span className="text-xs text-zinc-500">موفق</span>
            <span className="tnum text-xl font-semibold text-emerald-500">
              {summary.passed.toLocaleString("fa-IR")}
            </span>
          </div>
          <div className="flex flex-col gap-1.5 rounded-xl border border-zinc-800 bg-zinc-900/60 p-4">
            <span className="text-xs text-zinc-500">ناموفق</span>
            <span
              className={cn(
                "tnum text-xl font-semibold",
                summary.failed > 0 ? "text-red-500" : "text-zinc-300"
              )}
            >
              {summary.failed.toLocaleString("fa-IR")}
            </span>
          </div>
          <div className="flex flex-col gap-1.5 rounded-xl border border-zinc-800 bg-zinc-900/60 p-4">
            <span className="text-xs text-zinc-500">میانگین تأخیر</span>
            <span className="font-mono tnum text-xl font-semibold text-zinc-100">
              {fmtLatin(summary.avg, 0)}
              <span className="ms-1 text-xs font-normal text-zinc-500">ms</span>
            </span>
          </div>
          <div className="flex flex-col gap-1.5 rounded-xl border border-zinc-800 bg-zinc-900/60 p-4">
            <span className="text-xs text-zinc-500">در حال اجرا</span>
            <span className="tnum text-xl font-semibold text-amber-400">
              {summary.running.toLocaleString("fa-IR")}
            </span>
          </div>
        </div>
      ) : null}

      {/* results */}
      {runError && runId !== null ? (
        <ErrorBanner message={runError} onRetry={refreshRun} />
      ) : null}

      {displayResults.length === 0 ? (
        <EmptyState
          icon={<ClipboardCheck className="size-8" />}
          title="هنوز اجرایی ثبت نشده است"
          hint="با زدن دکمه بالا، مجموعه کامل تست‌های پذیرش اجرا و نتیجه به‌صورت زنده نمایش داده می‌شود."
        />
      ) : (
        <div className="max-h-[55vh] overflow-auto rounded-xl border border-zinc-800 bg-zinc-900/60">
          <Table>
            <TableHeader className="sticky top-0 z-10 bg-zinc-900">
              <TableRow className="border-zinc-800 hover:bg-transparent">
                <TableHead className="w-12 px-4 text-zinc-400">وضعیت</TableHead>
                <TableHead className="text-zinc-400">تست</TableHead>
                <TableHead className="text-zinc-400">کلید</TableHead>
                <TableHead className="text-zinc-400">مدت</TableHead>
                <TableHead className="text-zinc-400">تأخیر</TableHead>
                <TableHead className="text-zinc-400">جزئیات</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {displayResults.map((result) => (
                <TableRow key={result.id} className="hover:bg-zinc-800/40">
                  <TableCell className="px-4"><StatusIcon status={result.status} /></TableCell>
                  <TableCell className="text-sm text-zinc-200">{result.title}</TableCell>
                  <TableCell>
                    <Mono className="text-[11px] text-zinc-500">{result.testKey}</Mono>
                  </TableCell>
                  <TableCell>
                    <Mono className="text-xs text-zinc-300">{`${fmtLatin(result.durationMs, 0)}ms`}</Mono>
                  </TableCell>
                  <TableCell>
                    <Mono
                      className={cn(
                        "text-xs",
                        result.status === "fail" ? "text-red-400" : "text-zinc-400"
                      )}
                    >
                      {result.latencyMs > 0 ? `${fmtLatin(result.latencyMs, 0)}ms` : "—"}
                    </Mono>
                  </TableCell>
                  <TableCell className="max-w-sm text-xs leading-5 text-zinc-500">
                    {result.detail || "—"}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      )}

      {/* past runs */}
      <SectionCard title="اجرای‌های قبلی" contentClassName="p-0 sm:p-0">
        {runs.length === 0 ? (
          <div className="p-6">
            <EmptyState title="تاریخچه‌ای از اجرای تست‌ها وجود ندارد" />
          </div>
        ) : (
          <div className="max-h-72 overflow-auto">
            <Table>
              <TableHeader>
                <TableRow className="border-zinc-800 hover:bg-transparent">
                  <TableHead className="px-4 text-zinc-400">شروع</TableHead>
                  <TableHead className="text-zinc-400">وضعیت</TableHead>
                  <TableHead className="text-zinc-400">موفق</TableHead>
                  <TableHead className="text-zinc-400">ناموفق</TableHead>
                  <TableHead className="text-zinc-400">میانگین تأخیر</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {[...runs]
                  .sort((a, b) => b.startedAt - a.startedAt)
                  .slice(0, 20)
                  .map((run) => (
                    <TableRow key={run.id} className="hover:bg-zinc-800/40">
                      <TableCell className="whitespace-nowrap px-4 text-xs text-zinc-400">
                        <FaDateTime ts={run.startedAt} />
                      </TableCell>
                      <TableCell>
                        <Badge
                          variant="outline"
                          className={cn(
                            "text-[11px]",
                            run.status === "done"
                              ? "border-emerald-500/30 bg-emerald-500/10 text-emerald-400"
                              : run.status === "failed"
                                ? "border-red-500/30 bg-red-500/10 text-red-400"
                                : "border-amber-500/30 bg-amber-500/10 text-amber-400"
                          )}
                        >
                          {run.status === "done" ? "کامل" : run.status === "failed" ? "ناموفق" : "در حال اجرا"}
                        </Badge>
                      </TableCell>
                      <TableCell className="tnum text-sm text-emerald-500">
                        {run.passed.toLocaleString("fa-IR")}
                      </TableCell>
                      <TableCell
                        className={cn("tnum text-sm", run.failed > 0 ? "text-red-500" : "text-zinc-500")}
                      >
                        {run.failed.toLocaleString("fa-IR")}
                      </TableCell>
                      <TableCell>
                        <Mono className="text-xs text-zinc-300">{`${fmtLatin(run.avgLatencyMs, 0)}ms`}</Mono>
                      </TableCell>
                    </TableRow>
                  ))}
              </TableBody>
            </Table>
          </div>
        )}
      </SectionCard>

      {error && !data ? <ErrorBanner message={error} onRetry={refresh} /> : null}
    </div>
  );
}
