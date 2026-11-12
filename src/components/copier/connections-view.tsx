"use client";

import { useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
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
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Badge } from "@/components/ui/badge";
import { Plus, Power, PlugZap, Trash2, Cable } from "lucide-react";

import { cn } from "@/lib/utils";
import type { SnapshotDTO, TerminalDTO } from "@/lib/types";
import { apiDelete, apiPatch, apiPost, errorMessage } from "./api";
import {
  ErrorBanner,
  MonoChip,
  PageSkeleton,
  RoleBadge,
  StatusBadge,
  TERMINAL_STATUS_META,
  EmptyState,
} from "./common";
import { Mono, RelativeTime, faCount } from "./format";
import { usePolling } from "./use-polling";

const EMPTY_FORM = { name: "", broker: "", server: "", exePath: "" };

function AddTerminalDialog({ onCreated }: { onCreated: () => void }) {
  const [open, setOpen] = useState(false);
  const [form, setForm] = useState(EMPTY_FORM);
  const [busy, setBusy] = useState(false);

  const submit = async () => {
    if (!form.name.trim()) {
      toast.error("نام ترمینال الزامی است");
      return;
    }
    setBusy(true);
    try {
      await apiPost("/api/terminals", {
        name: form.name.trim(),
        broker: form.broker.trim() || undefined,
        server: form.server.trim() || undefined,
        exePath: form.exePath.trim() || undefined,
      });
      toast.success(`ترمینال «${form.name.trim()}» ثبت شد`);
      setForm(EMPTY_FORM);
      setOpen(false);
      onCreated();
    } catch (err) {
      toast.error(errorMessage(err, "ثبت ترمینال ناموفق بود"));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (!next) setForm(EMPTY_FORM);
      }}
    >
      <DialogTrigger asChild>
        <Button className="h-11 sm:h-9">
          <Plus className="size-4" />
          افزودن ترمینال
        </Button>
      </DialogTrigger>
      <DialogContent className="border-zinc-800 bg-zinc-900 sm:max-w-md">
        <DialogHeader className="text-start">
          <DialogTitle>افزودن ترمینال MT5</DialogTitle>
          <DialogDescription>
            مسیر نصب ترمینال را دستی وارد کنید؛ موتور از طریق اکسپرت همان مسیر به ترمینال متصل می‌شود.
          </DialogDescription>
        </DialogHeader>
        <div className="flex flex-col gap-4">
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="term-name">نام ترمینال</Label>
            <Input
              id="term-name"
              dir="ltr"
              className="text-start"
              placeholder="Terminal 1"
              value={form.name}
              onChange={(e) => setForm({ ...form, name: e.target.value })}
            />
          </div>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="term-broker">کارگزاری</Label>
            <Input
              id="term-broker"
              className="text-start"
              placeholder="مثلاً Alpari"
              value={form.broker}
              onChange={(e) => setForm({ ...form, broker: e.target.value })}
            />
          </div>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="term-server">سرور</Label>
            <Input
              id="term-server"
              dir="ltr"
              className="text-start"
              placeholder="Alpari-MT5-Demo"
              value={form.server}
              onChange={(e) => setForm({ ...form, server: e.target.value })}
            />
          </div>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="term-exe">مسیر نصب (exePath)</Label>
            <Input
              id="term-exe"
              dir="ltr"
              className="text-start font-mono text-xs"
              placeholder="C:\\Program Files\\MetaTrader 5\\terminal64.exe"
              value={form.exePath}
              onChange={(e) => setForm({ ...form, exePath: e.target.value })}
            />
          </div>
        </div>
        <DialogFooter className="gap-2">
          <Button variant="outline" onClick={() => setOpen(false)} className="h-11 sm:h-9">
            انصراف
          </Button>
          <Button onClick={submit} disabled={busy} className="h-11 sm:h-9">
            {busy ? "در حال ثبت..." : "ثبت ترمینال"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function DeleteTerminalDialog({ terminal, onDeleted }: { terminal: TerminalDTO; onDeleted: () => void }) {
  const [busy, setBusy] = useState(false);
  const [open, setOpen] = useState(false);

  const remove = async () => {
    setBusy(true);
    try {
      await apiDelete(`/api/terminals/${terminal.id}`);
      toast.success(`ترمینال «${terminal.name}» حذف شد`);
      setOpen(false);
      onDeleted();
    } catch (err) {
      toast.error(errorMessage(err, "حذف ترمینال ناموفق بود"));
    } finally {
      setBusy(false);
    }
  };

  return (
    <AlertDialog open={open} onOpenChange={setOpen}>
      <AlertDialogTrigger asChild>
        <Button
          variant="ghost"
          size="icon"
          aria-label={`حذف ترمینال ${terminal.name}`}
          className="size-11 text-zinc-500 hover:bg-red-500/10 hover:text-red-400 sm:size-9"
        >
          <Trash2 className="size-4" />
        </Button>
      </AlertDialogTrigger>
      <AlertDialogContent className="border-zinc-800 bg-zinc-900">
        <AlertDialogHeader className="text-start">
          <AlertDialogTitle>حذف ترمینال «{terminal.name}»؟</AlertDialogTitle>
          <AlertDialogDescription>
            ترمینال از فهرست حذف می‌شود و سابقه اتصال آن پاک خواهد شد. معاملات ثبت‌شده حفظ می‌شوند.
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter className="gap-2">
          <AlertDialogCancel className="h-11 sm:h-9">انصراف</AlertDialogCancel>
          <AlertDialogAction
            onClick={(e) => {
              e.preventDefault();
              remove();
            }}
            className="h-11 bg-red-600 text-white hover:bg-red-500 sm:h-9"
          >
            {busy ? "در حال حذف..." : "حذف قطعی"}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}

function TerminalRow({ terminal, onChanged }: { terminal: TerminalDTO; onChanged: () => void }) {
  const t = terminal;
  const [busy, setBusy] = useState(false);

  const patch = async (body: Record<string, unknown>, successMsg?: string) => {
    setBusy(true);
    try {
      await apiPatch(`/api/terminals/${t.id}`, body);
      if (successMsg) toast.success(successMsg);
      onChanged();
    } catch (err) {
      toast.error(errorMessage(err, "اجرای دستور ناموفق بود"));
    } finally {
      setBusy(false);
    }
  };

  const connected = t.status === "connected";

  return (
    <TableRow className="hover:bg-zinc-800/40">
      <TableCell className="max-w-[180px]">
        <div className="flex items-center gap-2">
          <span className="truncate text-sm font-medium text-zinc-100">{t.name}</span>
          <RoleBadge role={t.role} className="scale-90" />
          {t.simulated ? (
            <Badge variant="outline" className="hidden border-zinc-800 text-[10px] text-zinc-500 sm:inline-flex">
              شبیه‌سازی
            </Badge>
          ) : null}
        </div>
        <p className="mt-0.5 truncate text-xs text-zinc-500">
          {t.broker}
          {t.server ? ` · ${t.server}` : ""}
        </p>
      </TableCell>
      <TableCell><StatusBadge status={t.status} /></TableCell>
      <TableCell>
        <Mono className="text-xs text-zinc-300">{t.accountNumber || "—"}</Mono>
      </TableCell>
      <TableCell className="text-xs text-zinc-400">
        <RelativeTime ts={t.lastSeen} />
      </TableCell>
      <TableCell className="text-center text-xs text-zinc-300">{faCount(t.reconnectCount)}</TableCell>
      <TableCell className="hidden max-w-[220px] lg:table-cell">
        <Mono className="block truncate text-[11px] text-zinc-500" >
          {t.exePath || "—"}
        </Mono>
      </TableCell>
      <TableCell>
        <Switch
          checked={t.autoReconnect}
          disabled={busy}
          onCheckedChange={(next) => patch({ action: "autoReconnect", value: next })}
          aria-label={`اتصال خودکار ${t.name}`}
        />
      </TableCell>
      <TableCell>
        <div className="flex items-center justify-end gap-1.5">
          <Button
            variant={connected ? "outline" : "default"}
            size="sm"
            disabled={busy}
            onClick={() =>
              patch(
                { action: connected ? "disconnect" : "connect" },
                connected ? `ترمینال «${t.name}» قطع شد` : `در حال اتصال به «${t.name}»...`
              )
            }
            className={cn(
              "h-11 gap-1.5 sm:h-8",
              connected ? "border-zinc-700 text-zinc-300" : "bg-emerald-600 text-white hover:bg-emerald-500"
            )}
          >
            {connected ? <Power className="size-3.5" /> : <PlugZap className="size-3.5" />}
            {connected ? "قطع" : "اتصال"}
          </Button>
          <DeleteTerminalDialog terminal={t} onDeleted={onChanged} />
        </div>
      </TableCell>
    </TableRow>
  );
}

export function ConnectionsView() {
  const { data, error, loading, refresh } = usePolling<SnapshotDTO>("/api/state", 2000);

  if (loading && !data) return <PageSkeleton cards={4} />;
  if (error && !data) return <ErrorBanner message={error} onRetry={refresh} className="mb-6" />;
  if (!data) return null;

  const terminals = data.terminals;

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="flex items-center gap-2 text-lg font-bold text-zinc-100">
            <Cable className="size-5 text-amber-500" />
            اتصالات ترمینال‌ها
          </h1>
          <p className="mt-1 text-xs text-zinc-500">
            مدیریت اتصال، اتصال خودکار و حذف ترمینال‌های متاتریدر ۵
          </p>
        </div>
        <AddTerminalDialog onCreated={refresh} />
      </div>

      {terminals.length === 0 ? (
        <EmptyState
          icon={<Cable className="size-8" />}
          title="هنوز ترمینالی ثبت نشده است"
          hint="برای شروع، یک ترمینال MT5 با مسیر نصب آن اضافه کنید؛ سپس نقش مستر یا اسلیو را در تب «مستر و اسلیوها» تعیین کنید."
        />
      ) : (
        <div className="overflow-x-auto rounded-xl border border-zinc-800 bg-zinc-900/60">
          <Table>
            <TableHeader>
              <TableRow className="border-zinc-800 hover:bg-transparent">
                <TableHead className="text-zinc-400">ترمینال</TableHead>
                <TableHead className="text-zinc-400">وضعیت</TableHead>
                <TableHead className="text-zinc-400">حساب</TableHead>
                <TableHead className="text-zinc-400">آخرین فعالیت</TableHead>
                <TableHead className="text-center text-zinc-400">اتصال مجدد</TableHead>
                <TableHead className="hidden text-zinc-400 lg:table-cell">مسیر نصب</TableHead>
                <TableHead className="text-zinc-400">اتصال خودکار</TableHead>
                <TableHead className="text-start text-zinc-400">عملیات</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {terminals.map((t) => (
                <TerminalRow key={t.id} terminal={t} onChanged={refresh} />
              ))}
            </TableBody>
          </Table>
        </div>
      )}

      {/* status legend */}
      <div className="rounded-xl border border-zinc-800 bg-zinc-900/60 p-4 sm:p-6">
        <h2 className="text-sm font-semibold text-zinc-200">راهنمای وضعیت اتصال</h2>
        <div className="mt-4 grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-5">
          {(
            ["connected", "connecting", "reconnecting", "disconnected", "error"] as const
          ).map((status) => {
            const meta = TERMINAL_STATUS_META[status];
            return (
              <div key={status} className="rounded-lg border border-zinc-800/70 bg-zinc-950/40 p-3">
                <StatusBadge status={status} />
                <p className="mt-2 text-xs leading-5 text-zinc-500">{meta.hint}</p>
              </div>
            );
          })}
        </div>
      </div>

      <div className="flex items-center gap-2 text-[11px] text-zinc-600">
        <MonoChip>tip</MonoChip>
        در نسخه ویندوز، اتصال از طریق اکسپرت نصب‌شده روی همان مسیر انجام می‌شود؛ بدون ذخیره رمز عبور.
      </div>
    </div>
  );
}
