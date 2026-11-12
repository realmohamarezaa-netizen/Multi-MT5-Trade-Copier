"use client";

import { useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Slider } from "@/components/ui/slider";
import { Switch } from "@/components/ui/switch";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
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
  ArrowDownToLine,
  ArrowUpToLine,
  Clock,
  FlaskConical,
  ListPlus,
  Plus,
  RefreshCcw,
  TrendingDown,
  TrendingUp,
  Trash2,
  Waves,
} from "lucide-react";
import { cn } from "@/lib/utils";

import type { SnapshotDTO } from "@/lib/types";
import { apiPost, apiPut, errorMessage } from "./api";
import { ErrorBanner, MonoChip, PageSkeleton, StatusBadge } from "./common";
import { Mono, fmtLatin } from "./format";
import { usePolling } from "./use-polling";

type SimAction =
  | "master_open"
  | "master_close"
  | "master_partial"
  | "master_modify"
  | "master_pending"
  | "master_cancel_pending"
  | "set_status"
  | "set_reject"
  | "spread_spike"
  | "add_terminal"
  | "remove_terminal"
  | "reset";

async function runSim(action: SimAction, params?: Record<string, unknown>): Promise<void> {
  await apiPost("/api/sim", { action, params: params ?? {} });
}

function ActionButton({
  label,
  icon,
  onClick,
  disabled,
}: {
  label: string;
  icon: React.ReactNode;
  onClick: () => void;
  disabled?: boolean;
}) {
  return (
    <Button
      variant="outline"
      disabled={disabled}
      onClick={onClick}
      className="h-auto min-h-20 flex-col gap-2 border-zinc-800 bg-zinc-950/40 text-zinc-300 hover:border-amber-500/40 hover:bg-amber-500/5 hover:text-amber-300"
    >
      {icon}
      <span className="text-xs font-medium">{label}</span>
    </Button>
  );
}

export function SimulatorView() {
  const { data, error, loading, refresh } = usePolling<SnapshotDTO>("/api/state", 2000);
  const { data: settingsData, refresh: refreshSettings } = usePolling<{
    masterAutoTrade: boolean;
    autoTradeIntervalMs: number;
  }>("/api/settings", 3000);

  const [busy, setBusy] = useState<string | null>(null);
  const [newName, setNewName] = useState("");
  const [newRole, setNewRole] = useState<"master" | "slave">("slave");
  const [intervalDraft, setIntervalDraft] = useState<string>("");

  if (loading && !data) return <PageSkeleton cards={4} />;
  if (error && !data) return <ErrorBanner message={error} onRetry={refresh} className="mb-6" />;
  if (!data) return null;

  const terminals = data.terminals;

  const execute = async (key: string, action: SimAction, params?: Record<string, unknown>, successMsg?: string) => {
    setBusy(key);
    try {
      await runSim(action, params);
      if (successMsg) toast.success(successMsg);
      refresh();
    } catch (err) {
      toast.error(errorMessage(err, "دستور شبیه‌ساز ناموفق بود"));
    } finally {
      setBusy(null);
    }
  };

  const autoTrade = settingsData?.masterAutoTrade ?? false;

  const toggleAutoTrade = async (next: boolean) => {
    setBusy("autotrade");
    try {
      await apiPut("/api/settings", {
        masterAutoTrade: next,
        ...(settingsData?.autoTradeIntervalMs
          ? { autoTradeIntervalMs: settingsData.autoTradeIntervalMs }
          : {}),
      });
      toast.success(next ? "معامله‌گر خودکار مستر فعال شد" : "معامله‌گر خودکار مستر خاموش شد");
      refreshSettings();
    } catch (err) {
      toast.error(errorMessage(err, "تغییر وضعیت معامله‌گر خودکار ناموفق بود"));
    } finally {
      setBusy(null);
    }
  };

  const applyInterval = async () => {
    const value = Number(intervalDraft);
    if (!Number.isFinite(value) || value < 2000 || value > 60000) {
      toast.error("فاصله باید بین ۲۰۰۰ تا ۶۰۰۰۰ میلی‌ثانیه باشد");
      return;
    }
    setBusy("interval");
    try {
      await apiPut("/api/settings", {
        masterAutoTrade: autoTrade,
        autoTradeIntervalMs: Math.round(value),
      });
      toast.success("فاصله معاملات خودکار اعمال شد");
      setIntervalDraft("");
      refreshSettings();
    } catch (err) {
      toast.error(errorMessage(err, "اعمال فاصله ناموفق بود"));
    } finally {
      setBusy(null);
    }
  };

  const addTerminal = async () => {
    const name = newName.trim() || `Sim ${terminals.length + 1}`;
    setBusy("add");
    try {
      await runSim("add_terminal", { name, role: newRole });
      toast.success(`ترمینال شبیه‌سازی‌شده «${name}» اضافه شد`);
      setNewName("");
      refresh();
    } catch (err) {
      toast.error(errorMessage(err, "افزودن ترمینال ناموفق بود"));
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="flex flex-col gap-6">
      <div>
        <h1 className="flex items-center gap-2 text-lg font-bold text-zinc-100">
          <FlaskConical className="size-5 text-amber-500" />
          شبیه‌ساز ترمینال MT5
        </h1>
      </div>

      <p className="flex items-start gap-2 rounded-xl border border-amber-500/25 bg-amber-500/5 p-4 text-xs leading-6 text-amber-200/90">
        <FlaskConical className="mt-1 size-4 shrink-0" />
        شبیه‌ساز ترمینال MT5 برای تست موتور در همین محیط است؛ روی ویندوز، همان موتور به ترمینال‌های
        واقعی متصل می‌شود و هیچ رفتار شبیه‌سازی‌ای باقی نمی‌ماند.
      </p>

      {/* master trade actions */}
      <section className="rounded-xl border border-zinc-800 bg-zinc-900/60 p-4 sm:p-6">
        <h2 className="text-sm font-semibold text-zinc-200">شبیه‌سازی معاملات مستر</h2>
        <p className="mt-1 text-[11px] text-zinc-500">
          رویدادها واقعاً از خط لوله کپی عبور می‌کنند و در داشبورد و مانیتور اجرا دیده می‌شوند.
        </p>
        <div className="mt-4 grid grid-cols-2 gap-3 md:grid-cols-4">
          <ActionButton
            label="باز کردن Buy در مستر"
            icon={<TrendingUp className="size-5 text-emerald-500" />}
            disabled={busy !== null}
            onClick={() => execute("openBuy", "master_open", { side: "buy" }, "معامله Buy آزمایشی در مستر باز شد")}
          />
          <ActionButton
            label="باز کردن Sell در مستر"
            icon={<TrendingDown className="size-5 text-red-500" />}
            disabled={busy !== null}
            onClick={() => execute("openSell", "master_open", { side: "sell" }, "معامله Sell آزمایشی در مستر باز شد")}
          />
          <ActionButton
            label="بستن تصادفی"
            icon={<ArrowDownToLine className="size-5 text-zinc-400" />}
            disabled={busy !== null}
            onClick={() => execute("close", "master_close", {}, "یک معامله مستر بسته شد")}
          />
          <ActionButton
            label="Partial Close"
            icon={<ArrowUpToLine className="size-5 text-zinc-400" />}
            disabled={busy !== null}
            onClick={() => execute("partial", "master_partial", {}, "بستن جزئی روی یک معامله مستر اجرا شد")}
          />
          <ActionButton
            label="تغییر SL/TP"
            icon={<Waves className="size-5 text-amber-500" />}
            disabled={busy !== null}
            onClick={() => execute("modify", "master_modify", {}, "SL/TP یک معامله مستر تغییر کرد")}
          />
          <ActionButton
            label="ثبت سفارش Pending"
            icon={<ListPlus className="size-5 text-amber-500" />}
            disabled={busy !== null}
            onClick={() => execute("pending", "master_pending", { pendingType: "buy_limit" }, "سفارش Pending در مستر ثبت شد")}
          />
          <ActionButton
            label="لغو Pending"
            icon={<RefreshCcw className="size-5 text-zinc-400" />}
            disabled={busy !== null}
            onClick={() => execute("cancel", "master_cancel_pending", {}, "یک سفارش Pending لغو شد")}
          />
          <ActionButton
            label="Spike اسپرد"
            icon={<Waves className="size-5 text-amber-400" />}
            disabled={busy !== null}
            onClick={() => execute("spike", "spread_spike", {}, "اسپرد موقتاً افزایش یافت — واکنش فیلتر اسپرد را ببینید")}
          />
        </div>
      </section>

      {/* auto trade */}
      <section className="rounded-xl border border-zinc-800 bg-zinc-900/60 p-4 sm:p-6">
        <h2 className="text-sm font-semibold text-zinc-200">معامله‌گر خودکار مستر</h2>
        <div className="mt-4 flex flex-col gap-4 sm:flex-row sm:items-end sm:gap-6">
          <div className="flex items-center gap-3">
            <Switch
              id="sim-autotrade"
              checked={autoTrade}
              disabled={busy === "autotrade"}
              onCheckedChange={toggleAutoTrade}
            />
            <Label htmlFor="sim-autotrade" className="text-sm text-zinc-300">
              {autoTrade ? "روشن" : "خاموش"}
            </Label>
          </div>
          <div className="flex items-end gap-2">
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="sim-interval" className="text-xs text-zinc-500">
                فاصله (ms — بین ۲۰۰۰ تا ۶۰۰۰۰)
              </Label>
              <Input
                id="sim-interval"
                dir="ltr"
                type="number"
                className="w-36 text-start font-mono"
                placeholder={settingsData ? String(settingsData.autoTradeIntervalMs) : "10000"}
                value={intervalDraft}
                onChange={(e) => setIntervalDraft(e.target.value)}
              />
            </div>
            <Button
              variant="outline"
              onClick={applyInterval}
              disabled={busy !== null}
              className="h-11 border-zinc-700 text-zinc-300 sm:h-9"
            >
              اعمال
            </Button>
          </div>
        </div>
      </section>

      {/* terminal controls */}
      <section className="rounded-xl border border-zinc-800 bg-zinc-900/60 p-4 sm:p-6">
        <h2 className="text-sm font-semibold text-zinc-200">ترمینال‌های شبیه‌سازی‌شده</h2>
        <div className="mt-4 flex flex-col gap-2 sm:flex-row sm:items-end">
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="sim-name" className="text-xs text-zinc-500">نام ترمینال</Label>
            <Input
              id="sim-name"
              className="w-full text-start sm:w-48"
              placeholder={`Sim ${terminals.length + 1}`}
              value={newName}
              onChange={(e) => setNewName(e.target.value)}
            />
          </div>
          <div className="flex flex-col gap-1.5">
            <span className="text-xs text-zinc-500">نقش</span>
            <Select value={newRole} onValueChange={(v) => setNewRole(v as "master" | "slave")}>
              <SelectTrigger className="h-11! w-36 sm:h-9!" aria-label="نقش ترمینال جدید">
                <SelectValue />
              </SelectTrigger>
              <SelectContent className="border-zinc-800 bg-zinc-900">
                <SelectItem value="slave">اسلیو</SelectItem>
                <SelectItem value="master">مستر</SelectItem>
              </SelectContent>
            </Select>
          </div>
          <Button
            onClick={addTerminal}
            disabled={busy !== null}
            className="h-11 gap-1.5 sm:h-9"
          >
            <Plus className="size-4" />
            افزودن ترمینال
          </Button>
        </div>

        <div className="mt-5 flex flex-col gap-3">
          {terminals.map((t) => (
            <div
              key={t.id}
              className="flex flex-col gap-3 rounded-lg border border-zinc-800 bg-zinc-950/40 p-3 xl:flex-row xl:items-center"
            >
              <div className="flex min-w-48 items-center gap-2">
                <span className="text-sm font-medium text-zinc-100">{t.name}</span>
                <Badge variant="outline" className="border-zinc-700 text-[10px] text-zinc-400">
                  {t.role === "master" ? "مستر" : t.role === "slave" ? "اسلیو" : "بدون نقش"}
                </Badge>
                <StatusBadge status={t.status} className="scale-90" />
              </div>
              <div className="flex flex-wrap items-center gap-2">
                <Button
                  variant="outline"
                  size="sm"
                  disabled={busy !== null}
                  onClick={() =>
                    execute(
                      `status-${t.id}`,
                      "set_status",
                      { terminalId: t.id, status: "disconnected" },
                      `«${t.name}» آفلاین شد`
                    )
                  }
                  className="h-11 border-zinc-700 text-zinc-300 sm:h-8"
                >
                  آفلاین
                </Button>
                <Button
                  variant="outline"
                  size="sm"
                  disabled={busy !== null}
                  onClick={() =>
                    execute(
                      `status-${t.id}`,
                      "set_status",
                      { terminalId: t.id, status: "connected" },
                      `«${t.name}» آنلاین شد`
                    )
                  }
                  className="h-11 border-emerald-500/30 text-emerald-400 hover:bg-emerald-500/10 sm:h-8"
                >
                  آنلاین
                </Button>
                <MonoChip>{`${t.balance.toFixed(0)} ${t.currency}`}</MonoChip>
              </div>
              {t.role === "slave" ? (
                <div className="flex min-w-56 flex-1 items-center gap-3">
                  <span className="whitespace-nowrap text-[11px] text-zinc-500">احتمال رد شدن:</span>
                  <Slider
                    className="flex-1"
                    value={[t.settings?.rejectProbability ?? 0]}
                    min={0}
                    max={1}
                    step={0.05}
                    disabled={busy !== null}
                    onValueCommit={([v]) =>
                      execute(
                        `reject-${t.id}`,
                        "set_reject",
                        { terminalId: t.id, value: v },
                        `احتمال رد شدن «${t.name}» به ${Math.round(v * 100)}% رسید`
                      )
                    }
                    aria-label={`احتمال رد شدن ${t.name}`}
                  />
                  <Mono className="w-10 text-xs text-zinc-300">
                    {`${Math.round((t.settings?.rejectProbability ?? 0) * 100)}%`}
                  </Mono>
                </div>
              ) : null}
              <div className="flex items-center gap-2 xl:ms-auto">
                <AlertDialog>
                  <AlertDialogTrigger asChild>
                    <Button
                      variant="ghost"
                      size="icon"
                      aria-label={`حذف ${t.name}`}
                      className="size-11 text-zinc-500 hover:bg-red-500/10 hover:text-red-400 sm:size-9"
                    >
                      <Trash2 className="size-4" />
                    </Button>
                  </AlertDialogTrigger>
                  <AlertDialogContent className="border-zinc-800 bg-zinc-900">
                    <AlertDialogHeader className="text-start">
                      <AlertDialogTitle>حذف ترمینال «{t.name}» از شبیه‌ساز؟</AlertDialogTitle>
                      <AlertDialogDescription>
                        ترمینال و اتصال آن حذف می‌شود؛ تنظیمات کلی حفظ می‌شوند.
                      </AlertDialogDescription>
                    </AlertDialogHeader>
                    <AlertDialogFooter className="gap-2">
                      <AlertDialogCancel className="h-11 sm:h-9">انصراف</AlertDialogCancel>
                      <AlertDialogAction
                        className="h-11 bg-red-600 text-white hover:bg-red-500 sm:h-9"
                        onClick={(e) => {
                          e.preventDefault();
                          execute(`remove-${t.id}`, "remove_terminal", { terminalId: t.id }, `ترمینال «${t.name}» حذف شد`);
                        }}
                      >
                        حذف
                      </AlertDialogAction>
                    </AlertDialogFooter>
                  </AlertDialogContent>
                </AlertDialog>
              </div>
            </div>
          ))}
          {terminals.length === 0 ? (
            <p className="rounded-lg border border-dashed border-zinc-800 p-4 text-center text-xs text-zinc-500">
              ترمینالی وجود ندارد؛ از فرم بالا یک ترمینال شبیه‌سازی‌شده اضافه کنید.
            </p>
          ) : null}
        </div>
      </section>

      {/* reset */}
      <section className={cn("flex flex-wrap items-center justify-between gap-3 rounded-xl border border-red-500/25 bg-red-500/5 p-4 sm:p-6")}>
        <div>
          <h2 className="flex items-center gap-2 text-sm font-semibold text-red-300">
            <Clock className="size-4" />
            بازنشانی شبیه‌ساز
          </h2>
          <p className="mt-1 text-xs leading-5 text-red-200/70">
            همه معاملات، کپی‌ها و لاگ‌های آزمایشی پاک می‌شوند؛ ترمینال‌ها و تنظیمات حفظ می‌شوند.
          </p>
        </div>
        <AlertDialog>
          <AlertDialogTrigger asChild>
            <Button className="h-11 bg-red-600 text-white hover:bg-red-500 sm:h-9">
              بازنشانی کامل داده‌ها
            </Button>
          </AlertDialogTrigger>
          <AlertDialogContent className="border-zinc-800 bg-zinc-900">
            <AlertDialogHeader className="text-start">
              <AlertDialogTitle>بازنشانی شبیه‌ساز؟</AlertDialogTitle>
              <AlertDialogDescription>
                این کار معاملات باز و بسته‌شده، دفتر کپی و لاگ‌های آزمایشی را پاک می‌کند و قابل بازگشت
                نیست. ترمینال‌ها و تنظیمات باقی می‌مانند.
              </AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter className="gap-2">
              <AlertDialogCancel className="h-11 sm:h-9">انصراف</AlertDialogCancel>
              <AlertDialogAction
                className="h-11 bg-red-600 text-white hover:bg-red-500 sm:h-9"
                onClick={(e) => {
                  e.preventDefault();
                  execute("reset", "reset", {}, "شبیه‌ساز بازنشانی شد");
                }}
              >
                بازنشانی قطعی
              </AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>
      </section>

      <p className="text-[11px] text-zinc-600">
        میانگین تأخیر فعلی موتور: <Mono>{`${fmtLatin(data.latency.average, 0)}ms`}</Mono> — برای مشاهده
        اثر دستورها به تب «مانیتور اجرا» سر بزنید.
      </p>
    </div>
  );
}
