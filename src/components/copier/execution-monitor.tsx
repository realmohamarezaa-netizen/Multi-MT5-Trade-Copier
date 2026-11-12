"use client";

import { useMemo } from "react";
import { Badge } from "@/components/ui/badge";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { Activity, Gauge, Info } from "lucide-react";
import { cn } from "@/lib/utils";

import type {
  CopyOperationDTO,
  LatencyStatsDTO,
  SnapshotDTO,
} from "@/lib/types";
import {
  ACTION_LABELS,
  COPY_STATUS_META,
  EmptyState,
  ErrorBanner,
  PageSkeleton,
  SectionCard,
} from "./common";
import { Mono, RelativeTime, faCount, fmtLatin } from "./format";
import { usePolling } from "./use-polling";
import { Sparkline, SparklineLegend } from "./sparkline";

function TimelineDots({ op }: { op: CopyOperationDTO }) {
  const stages = [
    { key: "detect", label: "شناسایی", at: op.detectedAt },
    { key: "sent", label: "ارسال", at: op.sentAt },
    { key: "ack", label: "تأیید", at: op.ackAt },
    { key: "done", label: "پایان", at: op.doneAt },
  ];
  const deltas = [
    op.sentAt > 0 && op.detectedAt > 0 ? op.sentAt - op.detectedAt : null,
    op.ackAt > 0 && op.sentAt > 0 ? op.ackAt - op.sentAt : null,
    op.doneAt > 0 && op.ackAt > 0 ? op.doneAt - op.ackAt : null,
  ];
  const ok = op.status === "executed";

  return (
    <div className="flex flex-col gap-1">
      <div dir="ltr" className="flex items-center">
        {stages.map((stage, index) => (
          <div key={stage.key} className="flex items-center">
            {index > 0 ? (
              <span
                className={cn(
                  "h-px w-4 sm:w-6",
                  stage.at > 0 ? (ok ? "bg-emerald-500/60" : "bg-red-500/60") : "bg-zinc-800"
                )}
              />
            ) : null}
            <Tooltip>
              <TooltipTrigger asChild>
                <span
                  className={cn(
                    "inline-block size-2.5 rounded-full border",
                    stage.at > 0
                      ? ok
                        ? "border-emerald-400 bg-emerald-500"
                        : "border-red-400 bg-red-500"
                      : "border-zinc-700 bg-zinc-950"
                  )}
                />
              </TooltipTrigger>
              <TooltipContent className="border-zinc-700 bg-zinc-900 text-xs text-zinc-200">
                {stage.label}
                {stage.at > 0 ? ` — ${fmtLatin(stage.at - op.detectedAt, 0)}ms از شناسایی` : " — در انتظار"}
              </TooltipContent>
            </Tooltip>
          </div>
        ))}
        <Mono className="ms-2 text-[10px] text-zinc-500">
          {deltas
            .map((d) => (d === null ? "·" : String(d)))
            .join("/")}
          ms
        </Mono>
      </div>
    </div>
  );
}

export function ExecutionMonitorView() {
  const { data: snapshot, error: stateError, loading: stateLoading, refresh: refreshState } =
    usePolling<SnapshotDTO>("/api/state", 2000);
  const { data: metrics, error: metricsError, loading: metricsLoading, refresh: refreshMetrics } =
    usePolling<LatencyStatsDTO>("/api/metrics", 2000);
  const { data: copies, error: copiesError, loading: copiesLoading, refresh: refreshCopies } =
    usePolling<CopyOperationDTO[]>("/api/copies?limit=50", 2000);

  const latency = metrics ?? snapshot?.latency ?? null;

  const recent = useMemo(() => {
    const list = latency?.recent ?? [];
    return [...list].sort((a, b) => a.ts - b.ts);
  }, [latency?.recent]);

  const ledger = useMemo(() => {
    const list = copies ?? [];
    return [...list].sort((a, b) => b.detectedAt - a.detectedAt);
  }, [copies]);

  if (
    (stateLoading && !snapshot) ||
    (metricsLoading && !metrics)
  ) {
    return <PageSkeleton cards={4} />;
  }

  if (!latency) {
    const err = metricsError ?? stateError;
    return (
      <ErrorBanner
        message={err ?? "داده مانیتور در دسترس نیست"}
        onRetry={() => {
          refreshState();
          refreshMetrics();
          refreshCopies();
        }}
      />
    );
  }

  const statCards: { title: string; node: React.ReactNode; hint?: string }[] = [
    {
      title: "تأخیر فعلی",
      node: (
        <>
          <span className="font-mono tnum text-zinc-100">{fmtLatin(latency.current, 0)}</span>
          <span className="text-xs font-normal text-zinc-500">ms</span>
        </>
      ),
    },
    {
      title: "میانگین تأخیر",
      node: (
        <>
          <span className="font-mono tnum text-zinc-100">{fmtLatin(latency.average, 0)}</span>
          <span className="text-xs font-normal text-zinc-500">ms</span>
        </>
      ),
      hint: `${faCount(latency.samples)} نمونه`,
    },
    {
      title: "کمینه",
      node: (
        <>
          <span className="font-mono tnum text-emerald-500">{fmtLatin(latency.min, 0)}</span>
          <span className="text-xs font-normal text-zinc-500">ms</span>
        </>
      ),
    },
    {
      title: "بیشینه",
      node: (
        <>
          <span className={cn("font-mono tnum", latency.max > 500 ? "text-amber-400" : "text-zinc-100")}>
            {fmtLatin(latency.max, 0)}
          </span>
          <span className="text-xs font-normal text-zinc-500">ms</span>
        </>
      ),
    },
    {
      title: "کپی موفق",
      node: <span className="tnum text-emerald-500">{faCount(latency.successfulCopies)}</span>,
    },
    {
      title: "کپی ناموفق",
      node: (
        <span className={cn("tnum", latency.failedCopies > 0 ? "text-red-500" : "text-zinc-300")}>
          {faCount(latency.failedCopies)}
        </span>
      ),
    },
    {
      title: "رویدادهای جاافتاده",
      node: (
        <span className={cn("tnum", latency.missedEvents > 0 ? "text-amber-400" : "text-zinc-300")}>
          {faCount(latency.missedEvents)}
        </span>
      ),
    },
    {
      title: "اتصال‌های مجدد",
      node: (
        <span className={cn("tnum", latency.reconnectionEvents > 0 ? "text-amber-400" : "text-zinc-300")}>
          {faCount(latency.reconnectionEvents)}
        </span>
      ),
    },
  ];

  return (
    <div className="flex flex-col gap-6">
      <div>
        <h1 className="flex items-center gap-2 text-lg font-bold text-zinc-100">
          <Activity className="size-5 text-amber-500" />
          مانیتور اجرا
        </h1>
        <p className="mt-1 text-xs text-zinc-500">
          سنجه‌های زنده خط لوله کپی: تأخیر، موفقیت و دفتر عملیات
        </p>
      </div>

      <div className="grid grid-cols-2 gap-4 md:grid-cols-4">
        {statCards.map((card) => (
          <div key={card.title} className="flex flex-col gap-1.5 rounded-xl border border-zinc-800 bg-zinc-900/60 p-4">
            <span className="text-xs text-zinc-500">{card.title}</span>
            <div className="flex items-baseline gap-1.5 text-xl font-semibold">{card.node}</div>
            {card.hint ? <span className="text-[11px] text-zinc-600">{card.hint}</span> : null}
          </div>
        ))}
      </div>

      <div className="grid grid-cols-1 gap-6 xl:grid-cols-5">
        <SectionCard
          className="xl:col-span-3"
          title={
            <span className="flex items-center gap-2">
              <Gauge className="size-4 text-amber-500" />
              نمودار تأخیر اخیر
            </span>
          }
          description="هر نقطه یک عملیات کپی است (۶۰ نمونه آخر)"
          action={<SparklineLegend />}
        >
          <Sparkline data={recent} />
          <p className="mt-3 text-[11px] text-zinc-600">
            آخرین رویداد: <RelativeTime ts={latency.lastEventAt} />
          </p>
        </SectionCard>

        <SectionCard
          className="xl:col-span-2"
          title="تأخیر به تفکیک اسلیو"
          contentClassName="p-0 sm:p-0"
        >
          {(latency.perSlave ?? []).length === 0 ? (
            <div className="p-6">
              <EmptyState title="هنوز کپی برای اسلیوی ثبت نشده است" />
            </div>
          ) : (
            <div className="max-h-72 overflow-auto px-0">
              <Table>
                <TableHeader>
                  <TableRow className="border-zinc-800 hover:bg-transparent">
                    <TableHead className="px-4 text-zinc-400">اسلیو</TableHead>
                    <TableHead className="text-zinc-400">میانگین</TableHead>
                    <TableHead className="text-zinc-400">تعداد</TableHead>
                    <TableHead className="text-zinc-400">موفق</TableHead>
                    <TableHead className="text-zinc-400">ناموفق</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {latency.perSlave.map((row) => (
                    <TableRow key={row.terminalId} className="hover:bg-zinc-800/40">
                      <TableCell className="px-4 text-sm text-zinc-200">{row.name}</TableCell>
                      <TableCell>
                        <Mono className="text-xs text-zinc-300">{`${fmtLatin(row.avgMs, 0)}ms`}</Mono>
                      </TableCell>
                      <TableCell className="text-xs text-zinc-300">{faCount(row.count)}</TableCell>
                      <TableCell className="text-xs text-emerald-500">{faCount(row.ok)}</TableCell>
                      <TableCell className={cn("text-xs", row.failed > 0 ? "text-red-500" : "text-zinc-500")}>
                        {faCount(row.failed)}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          )}
        </SectionCard>
      </div>

      {/* live ledger */}
      <SectionCard
        title="دفتر زنده عملیات کپی"
        description="۵۰ عملیات آخر خط لوله — شناسایی تا پایان با تفکیک زمانی"
        contentClassName="p-0 sm:p-0"
      >
        {copiesError && !copies ? (
          <div className="p-6">
            <ErrorBanner message={copiesError} onRetry={refreshCopies} />
          </div>
        ) : ledger.length === 0 ? (
          <div className="p-6">
            <EmptyState
              title="هنوز عملیات کپی ثبت نشده است"
              hint="با اولین معامله مستر، ردیف‌های اجرا به‌صورت زنده این‌جا ظاهر می‌شوند."
            />
          </div>
        ) : (
          <div className="max-h-[55vh] overflow-auto">
            <Table>
              <TableHeader className="sticky top-0 z-10 bg-zinc-900">
                <TableRow className="border-zinc-800 hover:bg-transparent">
                  <TableHead className="px-4 text-zinc-400">تیکت مستر</TableHead>
                  <TableHead className="text-zinc-400">اسلیو</TableHead>
                  <TableHead className="text-zinc-400">عملیات</TableHead>
                  <TableHead className="text-zinc-400">وضعیت</TableHead>
                  <TableHead className="text-zinc-400">تأخیر</TableHead>
                  <TableHead className="text-zinc-400">کل</TableHead>
                  <TableHead className="text-zinc-400">خط لوله</TableHead>
                  <TableHead className="text-zinc-400">زمان</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {ledger.map((op) => {
                  const meta = COPY_STATUS_META[op.status];
                  return (
                    <TableRow key={op.id} className="hover:bg-zinc-800/40">
                      <TableCell className="px-4">
                        <Mono className="text-xs text-zinc-300">{op.masterTicket}</Mono>
                      </TableCell>
                      <TableCell className="text-sm text-zinc-200">{op.slaveName}</TableCell>
                      <TableCell className="text-xs text-zinc-300">
                        {ACTION_LABELS[op.action] ?? op.action}
                      </TableCell>
                      <TableCell>
                        {op.status === "failed" && op.failReason ? (
                          <Tooltip>
                            <TooltipTrigger asChild>
                              <span>
                                <Badge variant="outline" className={cn("cursor-help", meta.badge)}>
                                  {meta.label}
                                </Badge>
                              </span>
                            </TooltipTrigger>
                            <TooltipContent className="max-w-xs border-zinc-700 bg-zinc-900 text-zinc-200">
                              <p className="font-medium">دلیل شکست:</p>
                              <p dir="ltr" className="mt-1 text-left font-mono text-[11px] text-zinc-400">
                                {op.failCode ? `${op.failCode} — ` : ""}
                                {op.failReason}
                              </p>
                            </TooltipContent>
                          </Tooltip>
                        ) : (
                          <Badge variant="outline" className={meta.badge}>
                            {meta.label}
                          </Badge>
                        )}
                      </TableCell>
                      <TableCell>
                        <Mono className={cn("text-xs", op.status === "failed" ? "text-red-400" : "text-zinc-300")}>
                          {`${fmtLatin(op.latencyMs, 0)}ms`}
                        </Mono>
                      </TableCell>
                      <TableCell>
                        <Mono className="text-xs text-zinc-400">{`${fmtLatin(op.totalMs, 0)}ms`}</Mono>
                      </TableCell>
                      <TableCell><TimelineDots op={op} /></TableCell>
                      <TableCell className="whitespace-nowrap text-xs text-zinc-500">
                        <RelativeTime ts={op.detectedAt} />
                      </TableCell>
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
          </div>
        )}
      </SectionCard>

      <p className="flex items-start gap-2 rounded-lg border border-zinc-800/70 bg-zinc-900/40 p-3 text-[11px] leading-5 text-zinc-500">
        <Info className="mt-0.5 size-3.5 shrink-0" />
        تأخیر صفر تضمین نمی‌شود؛ اعداد نمایش‌داده‌شده واقعی خط لوله اجرا هستند (شناسایی رویداد، ارسال
        دستور، تأیید ترمینال و پایان اجرا).
      </p>
    </div>
  );
}
