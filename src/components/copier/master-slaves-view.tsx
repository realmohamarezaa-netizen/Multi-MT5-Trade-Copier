"use client";

import { useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Label } from "@/components/ui/label";
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
} from "@/components/ui/alert-dialog";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import {
  ArrowRightLeft,
  Crown,
  Download,
  Eraser,
  Network,
} from "lucide-react";

import type { SnapshotDTO, TerminalDTO, TerminalRole } from "@/lib/types";
import { apiPatch, apiPost, errorMessage } from "./api";
import {
  EmptyState,
  ErrorBanner,
  LatencyText,
  PageSkeleton,
  RoleBadge,
  StatusBadge,
} from "./common";
import { faCount } from "./format";
import { usePolling } from "./use-polling";

function RoleSelect({
  terminal,
  busy,
  onPick,
}: {
  terminal: TerminalDTO;
  busy: boolean;
  onPick: (role: TerminalRole) => void;
}) {
  return (
    <Select
      value={terminal.role}
      disabled={busy}
      onValueChange={(value) => onPick(value as TerminalRole)}
    >
      <SelectTrigger
        size="sm"
        aria-label={`نقش ${terminal.name}`}
        className="h-11! min-w-32 sm:h-9!"
      >
        <SelectValue />
      </SelectTrigger>
      <SelectContent className="border-zinc-800 bg-zinc-900">
        <SelectItem value="master">
          <span className="flex items-center gap-1.5">
            <Crown className="size-3.5 text-amber-500" />
            مستر
          </span>
        </SelectItem>
        <SelectItem value="slave">
          <span className="flex items-center gap-1.5">اسلیو</span>
        </SelectItem>
        <SelectItem value="none">
          <span className="flex items-center gap-1.5 text-zinc-400">بدون نقش</span>
        </SelectItem>
      </SelectContent>
    </Select>
  );
}

function SlaveControls({
  terminal,
  avgLatency,
  busy,
  onChanged,
}: {
  terminal: TerminalDTO;
  avgLatency: number | null;
  busy: boolean;
  onChanged: () => void;
}) {
  const t = terminal;
  const [localBusy, setLocalBusy] = useState(false);
  const isBusy = localBusy || busy;

  const patch = async (body: Record<string, unknown>, successMsg?: string) => {
    setLocalBusy(true);
    try {
      await apiPatch(`/api/terminals/${t.id}`, body);
      if (successMsg) toast.success(successMsg);
      onChanged();
    } catch (err) {
      toast.error(errorMessage(err, "اجرای دستور ناموفق بود"));
    } finally {
      setLocalBusy(false);
    }
  };

  const sync = async (action: "open_missing" | "close_extra") => {
    setLocalBusy(true);
    try {
      const res = await apiPost<{ opened?: number; closed?: number }>("/api/sync", {
        slaveId: t.id,
        action,
      });
      toast.success(
        action === "open_missing"
          ? `همگام‌سازی انجام شد؛ ${res.opened ?? 0} پوزیشن باز شد`
          : `همگام‌سازی انجام شد؛ ${res.closed ?? 0} پوزیشن بسته شد`
      );
      onChanged();
    } catch (err) {
      toast.error(errorMessage(err, "همگام‌سازی ناموفق بود"));
    } finally {
      setLocalBusy(false);
    }
  };

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center gap-x-6 gap-y-3">
        <div className="flex items-center gap-2">
          <Switch
            id={`copy-${t.id}`}
            checked={t.enabled}
            disabled={isBusy}
            onCheckedChange={(next) =>
              patch(
                { action: next ? "enable" : "disable" },
                next ? `کپی برای «${t.name}» فعال شد` : `کپی برای «${t.name}» خاموش شد`
              )
            }
          />
          <Label htmlFor={`copy-${t.id}`} className="text-xs text-zinc-300">
            کپی فعال
          </Label>
        </div>
        <div className="flex items-center gap-2">
          <Switch
            id={`pause-${t.id}`}
            checked={t.paused}
            disabled={isBusy}
            onCheckedChange={(next) =>
              patch(
                { action: next ? "pause" : "resume" },
                next ? `«${t.name}» موقتاً متوقف شد` : `«${t.name}» از توقف خارج شد`
              )
            }
          />
          <Label htmlFor={`pause-${t.id}`} className="text-xs text-zinc-300">
            توقف موقت
          </Label>
        </div>
        <div className="flex items-center gap-2 text-xs text-zinc-500">
          تأخیر آخرین کپی: <LatencyText ms={avgLatency} className="text-zinc-300" />
        </div>
      </div>
      <div className="flex flex-wrap gap-2">
        <Button
          variant="outline"
          size="sm"
          disabled={isBusy}
          onClick={() => sync("open_missing")}
          className="h-11 gap-1.5 border-zinc-700 text-zinc-300 sm:h-8"
        >
          <Download className="size-3.5" />
          باز کردن جاافتاده‌ها
        </Button>
        <Button
          variant="outline"
          size="sm"
          disabled={isBusy}
          onClick={() => sync("close_extra")}
          className="h-11 gap-1.5 border-zinc-700 text-zinc-300 sm:h-8"
        >
          <Eraser className="size-3.5" />
          بستن اضافی‌ها
        </Button>
      </div>
    </div>
  );
}

export function MasterSlavesView() {
  const { data, error, loading, refresh } = usePolling<SnapshotDTO>("/api/state", 2000);
  const [pendingRole, setPendingRole] = useState<{ terminal: TerminalDTO; role: TerminalRole } | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);

  if (loading && !data) return <PageSkeleton cards={4} />;
  if (error && !data) return <ErrorBanner message={error} onRetry={refresh} className="mb-6" />;
  if (!data) return null;

  const { terminals, latency, stats } = data;
  const master = terminals.find((t) => t.role === "master");
  const slaves = terminals.filter((t) => t.role === "slave");

  const applyRole = async (terminal: TerminalDTO, role: TerminalRole) => {
    setBusyId(terminal.id);
    try {
      await apiPatch(`/api/terminals/${terminal.id}`, { action: "setRole", value: role });
      toast.success(
        role === "master"
          ? `«${terminal.name}» به‌عنوان مستر تعیین شد`
          : role === "slave"
            ? `«${terminal.name}» به‌عنوان اسلیو تعیین شد`
            : `نقش «${terminal.name}» حذف شد`
      );
      refresh();
    } catch (err) {
      toast.error(errorMessage(err, "تغییر نقش ناموفق بود"));
    } finally {
      setBusyId(null);
    }
  };

  const onPickRole = (terminal: TerminalDTO, role: TerminalRole) => {
    if (role === terminal.role) return;
    if (role === "master" && terminal.role !== "master") {
      setPendingRole({ terminal, role });
      return;
    }
    applyRole(terminal, role);
  };

  const latencyFor = (terminalId: string): number | null => {
    const row = latency.perSlave.find((p) => p.terminalId === terminalId);
    return row ? row.avgMs : null;
  };

  return (
    <div className="flex flex-col gap-6">
      <div>
        <h1 className="flex items-center gap-2 text-lg font-bold text-zinc-100">
          <Network className="size-5 text-amber-500" />
          مستر و اسلیوها
        </h1>
        <p className="mt-1 text-xs text-zinc-500">
          تعیین نقش ترمینال‌ها و کنترل سریع کپی هر اسلیو — تنها یک مستر مجاز است
        </p>
      </div>

      {master ? (
        <div className="flex flex-wrap items-center gap-3 rounded-xl border border-amber-500/30 bg-amber-500/10 p-4">
          <Crown className="size-5 text-amber-500" />
          <div className="min-w-0">
            <p className="text-sm font-semibold text-amber-300">مستر فعال: {master.name}</p>
            <p className="mt-0.5 text-xs text-amber-200/60">
              منبع کپی برای {faCount(stats.activeSlaves)} اسلیو فعال
            </p>
          </div>
          <StatusBadge status={master.status} className="ms-auto" />
        </div>
      ) : (
        <div className="rounded-xl border border-zinc-800 bg-zinc-900/60 p-4 text-sm text-zinc-400">
          هنوز مستری تعیین نشده است؛ برای شروع کپی، از جدول زیر نقش «مستر» را به یک ترمینال بدهید.
        </div>
      )}

      {terminals.length === 0 ? (
        <EmptyState
          icon={<Network className="size-8" />}
          title="ترمینالی برای مدیریت نقش‌ها وجود ندارد"
          hint="ابتدا از تب «اتصالات» ترمینال‌های موردنظر را ثبت کنید."
        />
      ) : (
        <div className="overflow-x-auto rounded-xl border border-zinc-800 bg-zinc-900/60">
          <Table>
            <TableHeader>
              <TableRow className="border-zinc-800 hover:bg-transparent">
                <TableHead className="text-zinc-400">ترمینال</TableHead>
                <TableHead className="text-zinc-400">وضعیت</TableHead>
                <TableHead className="text-zinc-400">نقش</TableHead>
                <TableHead className="text-zinc-400">پوزیشن باز</TableHead>
                <TableHead className="min-w-[280px] text-zinc-400">کنترل کپی (اسلیو)</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {terminals.map((t) => (
                <TableRow key={t.id} className="align-top hover:bg-zinc-800/40">
                  <TableCell className="pt-4">
                    <span className="text-sm font-medium text-zinc-100">{t.name}</span>
                    <p className="mt-0.5 text-xs text-zinc-500">{t.broker}</p>
                  </TableCell>
                  <TableCell className="pt-4"><StatusBadge status={t.status} /></TableCell>
                  <TableCell className="pt-4">
                    <div className="flex items-center gap-2">
                      <RoleSelect terminal={t} busy={busyId === t.id} onPick={(role) => onPickRole(t, role)} />
                      <RoleBadge role={t.role} className="hidden xl:inline-flex" />
                    </div>
                  </TableCell>
                  <TableCell className="pt-4 text-sm text-zinc-300">
                    {faCount(t.openPositionsCount)}
                  </TableCell>
                  <TableCell className="pb-4 pt-4">
                    {t.role === "slave" ? (
                      <SlaveControls
                        terminal={t}
                        avgLatency={latencyFor(t.id)}
                        busy={busyId === t.id}
                        onChanged={refresh}
                      />
                    ) : (
                      <span className="text-xs text-zinc-600">
                        {t.role === "master" ? "ترمینال مستر — منبع کپی" : "برای فعال‌سازی کنترل‌ها، نقش اسلیو بدهید"}
                      </span>
                    )}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      )}

      <p className="flex items-start gap-2 text-[11px] leading-5 text-zinc-600">
        <ArrowRightLeft className="mt-0.5 size-3.5 shrink-0" />
        «باز کردن جاافتاده‌ها» فقط با انتخاب صریح شما اجرا می‌شود؛ موتور به‌طور پیش‌فرض هیچ پوزیشنی را خودکار باز نمی‌کند.
      </p>

      {/* master-change confirmation */}
      <AlertDialog
        open={pendingRole !== null}
        onOpenChange={(open) => {
          if (!open) setPendingRole(null);
        }}
      >
        <AlertDialogContent className="border-zinc-800 bg-zinc-900">
          <AlertDialogHeader className="text-start">
            <AlertDialogTitle>تغییر مستر به «{pendingRole?.terminal.name}»؟</AlertDialogTitle>
            <AlertDialogDescription>
              تنها یک مستر مجاز است. با تغییر مستر، ترمینال جدید منبع کپی می‌شود و سیاست همگام‌سازی
              اسلیوها بازنگری خواهد شد. اسلیو قبلی نقش خود را از دست می‌دهد.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter className="gap-2">
            <AlertDialogCancel className="h-11 sm:h-9">انصراف</AlertDialogCancel>
            <AlertDialogAction
              className="h-11 bg-amber-600 text-zinc-950 hover:bg-amber-500 sm:h-9"
              onClick={(e) => {
                e.preventDefault();
                if (pendingRole) applyRole(pendingRole.terminal, pendingRole.role);
                setPendingRole(null);
              }}
            >
              تایید و تغییر مستر
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
