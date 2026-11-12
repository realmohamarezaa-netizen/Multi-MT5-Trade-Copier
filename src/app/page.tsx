"use client";

import { useState } from "react";
import { toast } from "sonner";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog";
import {
  Activity,
  Cable,
  ClipboardCheck,
  Copy,
  FlaskConical,
  History,
  LayoutDashboard,
  Network,
  Play,
  RefreshCw,
  ScrollText,
  Settings,
  SlidersHorizontal,
  Square,
  TrendingUp,
  TriangleAlert,
} from "lucide-react";
import { cn } from "@/lib/utils";

import type { SnapshotDTO } from "@/lib/types";
import { apiPost, errorMessage } from "@/components/copier/api";
import { LiveClock, faCount } from "@/components/copier/format";
import { usePolling } from "@/components/copier/use-polling";
import { DashboardView } from "@/components/copier/dashboard-view";
import { ConnectionsView } from "@/components/copier/connections-view";
import { MasterSlavesView } from "@/components/copier/master-slaves-view";
import { SettingsView } from "@/components/copier/settings-view";
import { OpenPositionsView } from "@/components/copier/open-positions-view";
import { ClosedPositionsView } from "@/components/copier/closed-positions-view";
import { ExecutionMonitorView } from "@/components/copier/execution-monitor";
import { LogsView } from "@/components/copier/logs-view";
import { GeneralSettingsView } from "@/components/copier/general-settings-view";
import { SimulatorView } from "@/components/copier/simulator-view";
import { TestsView } from "@/components/copier/tests-view";

const TABS = [
  { key: "dashboard", label: "داشبورد", icon: LayoutDashboard },
  { key: "connections", label: "اتصالات", icon: Cable },
  { key: "roles", label: "مستر و اسلیوها", icon: Network },
  { key: "settings", label: "تنظیمات کپی", icon: SlidersHorizontal },
  { key: "open", label: "پوزیشن‌های باز", icon: TrendingUp },
  { key: "closed", label: "پوزیشن‌های بسته‌شده", icon: History },
  { key: "monitor", label: "مانیتور اجرا", icon: Activity },
  { key: "logs", label: "لاگ‌ها", icon: ScrollText },
  { key: "general", label: "تنظیمات عمومی", icon: Settings },
  { key: "simulator", label: "شبیه‌ساز", icon: FlaskConical },
  { key: "tests", label: "آزمون‌ها", icon: ClipboardCheck },
] as const;

type TabKey = (typeof TABS)[number]["key"];

const EMERGENCY_LABELS: Record<string, string> = {
  halt: "فقط توقف کپی (halt)",
  halt_close_master: "توقف + بستن مستر (halt_close_master)",
  halt_close_all: "توقف + بستن همه (halt_close_all)",
};

function EnginePill({ active, label }: { active: boolean; label: string }) {
  return (
    <Badge
      variant="outline"
      className={cn(
        "gap-1.5 px-2.5 py-1 text-[11px]",
        active
          ? "border-emerald-500/30 bg-emerald-500/10 text-emerald-400"
          : "border-zinc-700 bg-zinc-800/60 text-zinc-400"
      )}
    >
      <span
        className={cn(
          "inline-block size-1.5 rounded-full",
          active ? "animate-pulse bg-emerald-500" : "bg-zinc-500"
        )}
      />
      {label}
    </Badge>
  );
}

export default function Home() {
  const [tab, setTab] = useState<TabKey>("dashboard");
  const { data, error, loading, refresh } = usePolling<SnapshotDTO>("/api/state", 1000);
  const [busy, setBusy] = useState<string | null>(null);

  const stats = data?.stats ?? null;

  const engineAction = async (action: string, successMsg: string) => {
    setBusy(action);
    try {
      await apiPost("/api/engine", { action });
      toast.success(successMsg);
      refresh();
    } catch (err) {
      toast.error(errorMessage(err, "اجرای دستور موتور ناموفق بود"));
    } finally {
      setBusy(null);
    }
  };

  const renderTabButton = (item: (typeof TABS)[number], vertical: boolean) => {
    const active = tab === item.key;
    const Icon = item.icon;
    return (
      <button
        key={item.key}
        type="button"
        onClick={() => setTab(item.key)}
        aria-current={active ? "page" : undefined}
        className={cn(
          "flex items-center gap-2 rounded-lg border text-sm font-medium transition-colors",
          vertical
            ? "h-11 w-full justify-start px-3"
            : "h-11 shrink-0 px-3",
          active
            ? "border-amber-500/40 bg-amber-500/10 text-amber-400"
            : "border-transparent text-zinc-400 hover:bg-zinc-900 hover:text-zinc-200"
        )}
      >
        <Icon className="size-4 shrink-0" />
        {item.label}
      </button>
    );
  };

  return (
    <div className="flex min-h-screen flex-col bg-zinc-950 text-zinc-100">
      {/* header */}
      <header className="sticky top-0 z-40 border-b border-zinc-800 bg-zinc-950/85 backdrop-blur">
        <div className="mx-auto flex w-full max-w-[1600px] flex-wrap items-center gap-x-4 gap-y-2 px-3 py-2.5 sm:px-4">
          <div className="flex min-w-0 items-center gap-2.5">
            <span className="flex size-9 shrink-0 items-center justify-center rounded-lg border border-amber-500/40 bg-amber-500/10">
              <Copy className="size-4 text-amber-500" />
            </span>
            <h1 className="truncate text-sm font-bold sm:text-base">کوپیر چندترمیناله MT5</h1>
          </div>

          <div className="flex flex-wrap items-center gap-1.5">
            <EnginePill active={stats?.engineRunning ?? false} label={stats?.engineRunning ? "موتور فعال" : "موتور متوقف"} />
            <EnginePill active={stats?.copyEnabled ?? false} label={stats?.copyEnabled ? "کپی فعال" : "کپی متوقف"} />
            {stats?.masterName ? (
              <Badge variant="outline" className="border-amber-500/40 bg-amber-500/10 px-2.5 py-1 text-[11px] text-amber-400">
                مستر: {stats.masterName}
              </Badge>
            ) : (
              <Badge variant="outline" className="border-zinc-800 px-2.5 py-1 text-[11px] text-zinc-500">
                بدون مستر
              </Badge>
            )}
            <Badge variant="outline" className="border-zinc-800 px-2.5 py-1 text-[11px] text-zinc-400">
              {faCount(stats?.connectedTerminals ?? 0)}/{faCount(stats?.totalTerminals ?? 0)} متصل
            </Badge>
          </div>

          <div className="ms-auto flex flex-wrap items-center gap-2">
            <span className="hidden md:block">
              <LiveClock />
            </span>
            <Button
              size="sm"
              disabled={busy !== null || !stats}
              onClick={() =>
                engineAction(
                  stats?.copyEnabled ? "stop_copying" : "start_copying",
                  stats?.copyEnabled ? "کپی متوقف شد" : "کپی شروع شد"
                )
              }
              className="h-11 gap-1.5 bg-amber-500 text-zinc-950 hover:bg-amber-400 sm:h-9"
            >
              {stats?.copyEnabled ? <Square className="size-3.5" /> : <Play className="size-3.5" />}
              {stats?.copyEnabled ? "توقف کپی" : "شروع کپی"}
            </Button>

            <AlertDialog>
              <AlertDialogTrigger asChild>
                <Button
                  size="sm"
                  variant="outline"
                  disabled={busy !== null || !stats}
                  className="h-11 gap-1.5 border-red-500/40 text-red-400 hover:bg-red-500/10 sm:h-9"
                >
                  <TriangleAlert className="size-3.5" />
                  توقف اضطراری
                </Button>
              </AlertDialogTrigger>
              <AlertDialogContent className="border-red-500/30 bg-zinc-900">
                <AlertDialogHeader className="text-start">
                  <AlertDialogTitle className="text-red-400">توقف اضطراری موتور؟</AlertDialogTitle>
                  <AlertDialogDescription>
                    سیاست فعال فعلی: <span className="font-semibold text-zinc-200">{EMERGENCY_LABELS[stats?.emergencyPolicy ?? "halt"]}</span>
                    . سیاست پیش‌فرض «halt» فقط کپی را متوقف می‌کند و هیچ پوزیشنی بسته نمی‌شود؛
                    پوزیشن‌های باز همه ترمینال‌ها باز می‌مانند.
                  </AlertDialogDescription>
                </AlertDialogHeader>
                <AlertDialogFooter className="gap-2">
                  <AlertDialogCancel className="h-11 sm:h-9">انصراف</AlertDialogCancel>
                  <AlertDialogAction
                    className="h-11 bg-red-600 text-white hover:bg-red-500 sm:h-9"
                    onClick={(e) => {
                      e.preventDefault();
                      engineAction("emergency_stop", "توقف اضطراری اجرا شد");
                    }}
                  >
                    اجرای توقف اضطراری
                  </AlertDialogAction>
                </AlertDialogFooter>
              </AlertDialogContent>
            </AlertDialog>

            <AlertDialog>
              <AlertDialogTrigger asChild>
                <Button
                  size="sm"
                  variant="outline"
                  disabled={busy !== null || !stats}
                  className="h-11 gap-1.5 border-zinc-700 text-zinc-300 sm:h-9"
                >
                  <RefreshCw className={cn("size-3.5", busy === "restart" && "animate-spin")} />
                  ری‌استارت موتور
                </Button>
              </AlertDialogTrigger>
              <AlertDialogContent className="border-zinc-800 bg-zinc-900">
                <AlertDialogHeader className="text-start">
                  <AlertDialogTitle>ری‌استارت موتور کپی؟</AlertDialogTitle>
                  <AlertDialogDescription>
                    موتور متوقف و دوباره راه‌اندازی می‌شود؛ اتصال ترمینال‌ها بررسی و کپی ادامه
                    می‌یابد. پوزیشن‌ها تغییری نمی‌کنند.
                  </AlertDialogDescription>
                </AlertDialogHeader>
                <AlertDialogFooter className="gap-2">
                  <AlertDialogCancel className="h-11 sm:h-9">انصراف</AlertDialogCancel>
                  <AlertDialogAction
                    className="h-11 bg-amber-600 text-zinc-950 hover:bg-amber-500 sm:h-9"
                    onClick={(e) => {
                      e.preventDefault();
                      engineAction("restart", "موتور در حال ری‌استارت است");
                    }}
                  >
                    ری‌استارت
                  </AlertDialogAction>
                </AlertDialogFooter>
              </AlertDialogContent>
            </AlertDialog>
          </div>
        </div>
      </header>

      {/* mobile tab bar */}
      <nav aria-label="ناوبری" className="border-b border-zinc-800 bg-zinc-950 lg:hidden">
        <div className="flex gap-1 overflow-x-auto px-2 py-2">
          {TABS.map((item) => renderTabButton(item, false))}
        </div>
      </nav>

      {/* global state error */}
      {error && !data ? (
        <div className="mx-auto w-full max-w-[1600px] px-4 pt-4">
          <div className="rounded-xl border border-red-500/30 bg-red-500/10 px-4 py-3 text-sm text-red-300">
            دریافت وضعیت موتور ناموفق بود ({error}) — در حال تلاش مجدد خودکار...
          </div>
        </div>
      ) : null}

      {/* body */}
      <div className="mx-auto flex w-full max-w-[1600px] flex-1">
        {/* desktop rail */}
        <nav
          aria-label="ناوبری"
          className="sticky top-[57px] hidden h-fit max-h-[calc(100vh-5rem)] w-56 shrink-0 flex-col gap-1 overflow-y-auto border-e border-zinc-800 p-3 lg:flex"
        >
          {TABS.map((item) => renderTabButton(item, true))}
        </nav>

        <main className="min-w-0 flex-1 p-4 sm:p-6">
          {loading && !data ? (
            <div className="flex min-h-40 items-center justify-center text-sm text-zinc-500">
              در حال اتصال به موتور...
            </div>
          ) : (
            <>
              {tab === "dashboard" ? <DashboardView /> : null}
              {tab === "connections" ? <ConnectionsView /> : null}
              {tab === "roles" ? <MasterSlavesView /> : null}
              {tab === "settings" ? <SettingsView /> : null}
              {tab === "open" ? <OpenPositionsView /> : null}
              {tab === "closed" ? <ClosedPositionsView /> : null}
              {tab === "monitor" ? <ExecutionMonitorView /> : null}
              {tab === "logs" ? <LogsView /> : null}
              {tab === "general" ? <GeneralSettingsView /> : null}
              {tab === "simulator" ? <SimulatorView /> : null}
              {tab === "tests" ? <TestsView /> : null}
            </>
          )}
        </main>
      </div>

      {/* footer — mt-auto keeps it at the bottom on short pages */}
      <footer className="mt-auto border-t border-zinc-800 bg-zinc-950">
        <div className="mx-auto flex w-full max-w-[1600px] flex-col items-center justify-between gap-1.5 px-4 py-4 text-center text-[11px] text-zinc-600 sm:flex-row">
          <span>
            نسخه ۱.۰.۰ — تمام داده‌ها به‌صورت محلی ذخیره می‌شوند؛ هیچ اطلاعاتی به سرور خارجی ارسال
            نمی‌شود
          </span>
          <span dir="ltr" className="font-mono">
            multi-mt5-copier · build v1.0.0-local
          </span>
        </div>
      </footer>
    </div>
  );
}
