"use client";

import { cn } from "@/lib/utils";
import { Badge } from "@/components/ui/badge";
import { Separator } from "@/components/ui/separator";
import { Activity, Copy, Gauge } from "lucide-react";

import type { SnapshotDTO, TerminalDTO } from "@/lib/types";
import {
  ErrorBanner,
  PageSkeleton,
  RoleBadge,
  SectionCard,
  StatCard,
  StatusBadge,
} from "./common";
import {
  FaDateTime,
  Num,
  ProfitNum,
  RelativeTime,
  faCount,
} from "./format";
import { usePolling } from "./use-polling";
import { RelationsPanel } from "./relations-panel";

function AccountCard({ terminal }: { terminal: TerminalDTO }) {
  const t = terminal;
  return (
    <div className="flex flex-col rounded-xl border border-zinc-800 bg-zinc-900/60 p-4">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <span className="truncate text-sm font-semibold text-zinc-100">{t.name}</span>
            <RoleBadge role={t.role} />
            {t.simulated ? (
              <Badge variant="outline" className="border-zinc-800 text-[10px] text-zinc-500">
                شبیه‌سازی
              </Badge>
            ) : null}
          </div>
          <p className="mt-1 truncate text-xs text-zinc-500">
            {t.broker || "کارگزاری نامشخص"}
            {t.server ? ` · ${t.server}` : ""}
          </p>
        </div>
        <StatusBadge status={t.status} />
      </div>

      <Separator className="my-3 bg-zinc-800/70" />

      <dl className="grid grid-cols-2 gap-x-4 gap-y-2 text-xs sm:text-[13px]">
        <div className="flex items-center justify-between gap-2">
          <dt className="text-zinc-500">حساب</dt>
          <dd dir="ltr" className="font-mono tnum text-zinc-300">
            {t.accountNumber || "—"} {t.currency}
          </dd>
        </div>
        <div className="flex items-center justify-between gap-2">
          <dt className="text-zinc-500">Balance</dt>
          <dd><Num value={t.balance} className="text-zinc-200" /></dd>
        </div>
        <div className="flex items-center justify-between gap-2">
          <dt className="text-zinc-500">Equity</dt>
          <dd><Num value={t.equity} className="text-zinc-200" /></dd>
        </div>
        <div className="flex items-center justify-between gap-2">
          <dt className="text-zinc-500">سود شناور</dt>
          <dd><ProfitNum value={t.floatingPL} /></dd>
        </div>
        <div className="flex items-center justify-between gap-2">
          <dt className="text-zinc-500">Free Margin</dt>
          <dd><Num value={t.freeMargin} className="text-zinc-300" /></dd>
        </div>
        <div className="flex items-center justify-between gap-2">
          <dt className="text-zinc-500">Margin Level</dt>
          <dd>
            {t.marginLevel > 0 ? (
              <>
                <Num value={t.marginLevel} digits={1} className="text-zinc-300" />
                <span className="mr-1 text-zinc-500">%</span>
              </>
            ) : (
              <span className="text-zinc-600">—</span>
            )}
          </dd>
        </div>
        <div className="flex items-center justify-between gap-2">
          <dt className="text-zinc-500">باز</dt>
          <dd>{faCount(t.openPositionsCount)}</dd>
        </div>
        <div className="flex items-center justify-between gap-2">
          <dt className="text-zinc-500">بسته‌شده امروز</dt>
          <dd>{faCount(t.closedToday)}</dd>
        </div>
      </dl>

      {t.role === "slave" ? (
        <div className="mt-3 flex flex-wrap items-center gap-1.5 border-t border-zinc-800/70 pt-3">
          <Badge
            variant="outline"
            className={
              t.enabled
                ? "border-emerald-500/30 bg-emerald-500/10 text-emerald-400"
                : "border-zinc-700 bg-zinc-800/60 text-zinc-400"
            }
          >
            {t.enabled ? "کپی روشن" : "کپی خاموش"}
          </Badge>
          {t.paused ? (
            <Badge variant="outline" className="border-amber-500/30 bg-amber-500/10 text-amber-400">
              توقف موقت
            </Badge>
          ) : null}
          {t.pendingCount > 0 ? (
            <Badge variant="outline" className="border-zinc-700 text-zinc-400">
              Pending: {faCount(t.pendingCount)}
            </Badge>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

export function DashboardView() {
  const { data, error, loading, refresh } = usePolling<SnapshotDTO>("/api/state", 1000);

  if (loading && !data) return <PageSkeleton cards={6} />;
  if (error && !data) return <ErrorBanner message={error} onRetry={refresh} className="mb-6" />;
  if (!data) return null;

  const { stats, terminals, masterRelations, latency } = data;

  return (
    <div className="flex flex-col gap-6">
      {/* top stat cards */}
      <div className="grid grid-cols-2 gap-4 md:grid-cols-3 xl:grid-cols-5">
        <StatCard
          title="ترمینال‌های متصل"
          hint={`از مجموع ${faCount(stats.totalTerminals)} ترمینال`}
        >
          <span className={cn("tnum", stats.connectedTerminals > 0 ? "text-emerald-500" : "text-zinc-300")}>
            {faCount(stats.connectedTerminals)}
          </span>
          <span className="text-sm text-zinc-500">/ {faCount(stats.totalTerminals)}</span>
        </StatCard>
        <StatCard title="اسلیوهای فعال" hint="کپی روشن و متصل">
          <span className="tnum text-zinc-100">{faCount(stats.activeSlaves)}</span>
        </StatCard>
        <StatCard title="وضعیت مستر" hint={stats.masterStatus === "none" ? "مستری تعیین نشده است" : undefined}>
          {stats.masterStatus === "none" ? (
            <span className="text-sm font-medium text-zinc-500">بدون مستر</span>
          ) : (
            <>
              <span className="truncate text-sm font-medium text-amber-400">{stats.masterName}</span>
              <StatusBadge status={stats.masterStatus} className="scale-90" />
            </>
          )}
        </StatCard>
        <StatCard title="وضعیت موتور کپی" hint="اجرای موتور و وضعیت کپی">
          <div className="flex flex-wrap items-center gap-1.5">
            <Badge
              variant="outline"
              className={
                stats.engineRunning
                  ? "border-emerald-500/30 bg-emerald-500/10 text-emerald-400"
                  : "border-zinc-700 text-zinc-400"
              }
            >
              {stats.engineRunning ? "موتور فعال" : "موتور متوقف"}
            </Badge>
            <Badge
              variant="outline"
              className={
                stats.copyEnabled
                  ? "border-emerald-500/30 bg-emerald-500/10 text-emerald-400"
                  : "border-amber-500/30 bg-amber-500/10 text-amber-400"
              }
            >
              {stats.copyEnabled ? "کپی فعال" : "کپی متوقف"}
            </Badge>
          </div>
        </StatCard>
        <StatCard
          title="پوزیشن‌های باز کل"
          hint={`سفارش‌های Pending: ${faCount(stats.pendingTotal)}`}
        >
          <span className="tnum text-zinc-100">{faCount(stats.openPositionsTotal)}</span>
        </StatCard>
        <StatCard title="کپی‌های موفق امروز">
          <span className="tnum text-emerald-500">{faCount(stats.copiedToday)}</span>
        </StatCard>
        <StatCard title="کپی‌های ناموفق امروز">
          <span className={cn("tnum", stats.failedToday > 0 ? "text-red-500" : "text-zinc-300")}>
            {faCount(stats.failedToday)}
          </span>
        </StatCard>
        <StatCard title="میانگین تأخیر" hint={`بر پایه ${faCount(latency.samples)} نمونه`}>
          <span className="font-mono tnum text-zinc-100">{latency.average.toFixed(0)}</span>
          <span className="text-xs font-normal text-zinc-500">ms</span>
        </StatCard>
        <StatCard title="آخرین رویداد" hint="رویداد معاملاتی یا اتصال">
          <span className="text-sm font-medium text-zinc-200">
            <RelativeTime ts={stats.lastEventAt} />
          </span>
        </StatCard>
      </div>

      {/* account cards */}
      <section className="flex flex-col gap-3">
        <h2 className="flex items-center gap-2 text-sm font-semibold text-zinc-200">
          <Gauge className="size-4 text-amber-500" />
          حساب‌های ترمینال
        </h2>
        {terminals.length === 0 ? (
          <div className="rounded-xl border border-dashed border-zinc-800 bg-zinc-900/40 px-6 py-10 text-center text-sm text-zinc-500">
            هنوز ترمینالی اضافه نشده است؛ از تب «اتصالات» یک ترمینال ثبت کنید.
          </div>
        ) : (
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-3">
            {terminals.map((terminal) => (
              <AccountCard key={terminal.id} terminal={terminal} />
            ))}
          </div>
        )}
      </section>

      {/* master-slave relations */}
      <SectionCard
        title={
          <span className="flex items-center gap-2">
            <Activity className="size-4 text-amber-500" />
            روابط مستر و اسلیوها
          </span>
        }
        description="وضعیت اجرای هر معامله مستر روی اسلیوها — اجرا شده، ناموفق، رد شده یا جا افتاده"
      >
        <RelationsPanel relations={masterRelations} />
      </SectionCard>

      {/* subtle footer meta */}
      <p className="flex items-center gap-2 text-[11px] text-zinc-600">
        <Copy className="size-3" />
        آخرین به‌روزرسانی داده‌ها: <FaDateTime ts={stats.now} /> — به‌طور خودکار هر ثانیه تازه‌سازی می‌شود.
      </p>
    </div>
  );
}
