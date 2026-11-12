"use client";

import { useEffect, useState } from "react";
import { toast } from "sonner";
import { Label } from "@/components/ui/label";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Slider } from "@/components/ui/slider";
import { Switch } from "@/components/ui/switch";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import {
  Database,
  Save,
  Settings,
  ShieldCheck,
  TriangleAlert,
} from "lucide-react";

import { cn } from "@/lib/utils";
import type { AppSettingsDTO, EmergencyPolicy, SyncPolicy } from "@/lib/types";
import { apiPut, errorMessage } from "./api";
import { ErrorBanner, SectionCard } from "./common";
import { Mono, fmtLatin } from "./format";
import { usePolling } from "./use-polling";

const EMERGENCY_POLICIES: {
  value: EmergencyPolicy;
  label: string;
  description: string;
}[] = [
  {
    value: "halt",
    label: "فقط توقف کپی (پیش‌فرض)",
    description: "کپی فوراً متوقف می‌شود؛ هیچ پوزیشنی بسته نمی‌شود و همه موقعیت‌ها باز می‌مانند.",
  },
  {
    value: "halt_close_master",
    label: "توقف + بستن پوزیشن‌های مستر",
    description: "کپی متوقف می‌شود و پوزیشن‌های باز ترمینال مستر بسته می‌شوند.",
  },
  {
    value: "halt_close_all",
    label: "توقف + بستن همه پوزیشن‌ها",
    description: "کپی متوقف می‌شود و همه پوزیشن‌های باز مستر و اسلیوها بسته می‌شوند.",
  },
];

const SYNC_POLICIES: { value: SyncPolicy; label: string; hint: string }[] = [
  {
    value: "report",
    label: "فقط گزارش",
    hint: "مغایرت‌ها فقط در لاگ و داشبورد گزارش می‌شوند؛ هیچ اقدام خودکاری انجام نمی‌شود.",
  },
  {
    value: "autoOpenMissing",
    label: "باز کردن خودکار جاافتاده‌ها",
    hint: "پوزیشن‌هایی که در اسلیو باز نشده‌اند، هنگام شروع موتور خودکار باز می‌شوند.",
  },
  {
    value: "autoCloseExtra",
    label: "بستن خودکار اضافی‌ها",
    hint: "پوزیشن‌های اسلیو که معادل مستر ندارند، هنگام شروع موتور بسته می‌شوند.",
  },
];

type SettingsWithInfo = AppSettingsDTO & { info?: string };

export function GeneralSettingsView() {
  const { data, error, loading, refresh } = usePolling<SettingsWithInfo>("/api/settings", 3000);
  const [draft, setDraft] = useState<AppSettingsDTO | null>(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (data && !draft) setDraft({ ...data });
  }, [data, draft]);

  if (loading && !data) {
    return (
      <div className="flex flex-col gap-4">
        {Array.from({ length: 3 }).map((_, i) => (
          <div key={i} className="h-40 animate-pulse rounded-xl bg-zinc-900/60" />
        ))}
      </div>
    );
  }
  if (error && !data) return <ErrorBanner message={error} onRetry={refresh} />;
  if (!data || !draft) return null;

  const set = <K extends keyof AppSettingsDTO>(key: K, value: AppSettingsDTO[K]) => {
    setDraft((prev) => (prev ? { ...prev, [key]: value } : prev));
  };

  const save = async () => {
    setSaving(true);
    try {
      const saved = await apiPut<AppSettingsDTO>("/api/settings", draft);
      toast.success("تنظیمات عمومی ذخیره شد");
      setDraft({ ...saved });
      refresh();
    } catch (err) {
      toast.error(errorMessage(err, "ذخیره تنظیمات ناموفق بود"));
    } finally {
      setSaving(false);
    }
  };

  const dbPath = typeof data.info === "string" && data.info ? data.info : null;

  return (
    <div className="flex flex-col gap-6">
      <div>
        <h1 className="flex items-center gap-2 text-lg font-bold text-zinc-100">
          <Settings className="size-5 text-amber-500" />
          تنظیمات عمومی
        </h1>
        <p className="mt-1 text-xs text-zinc-500">
          سیاست‌های ایمنی، همگام‌سازی اولیه و پارامترهای شبیه‌ساز مستر
        </p>
      </div>

      {/* emergency policy */}
      <SectionCard
        title="سیاست توقف اضطراری"
        description="رفتار موتور هنگام فشردن «توقف اضطراری» در نوار بالا"
      >
        <RadioGroup
          value={draft.emergencyPolicy}
          onValueChange={(v) => set("emergencyPolicy", v as EmergencyPolicy)}
          className="grid grid-cols-1 gap-3 lg:grid-cols-3"
        >
          {EMERGENCY_POLICIES.map((policy) => (
            <div
              key={policy.value}
              className={cn(
                "flex items-start gap-2.5 rounded-lg border p-3 transition-colors",
                draft.emergencyPolicy === policy.value
                  ? "border-amber-500/40 bg-amber-500/5"
                  : "border-zinc-800 bg-zinc-950/40"
              )}
            >
              <RadioGroupItem value={policy.value} id={`policy-${policy.value}`} className="mt-0.5" />
              <div>
                <Label htmlFor={`policy-${policy.value}`} className="cursor-pointer text-sm text-zinc-200">
                  {policy.label}
                </Label>
                <p className="mt-1 text-[11px] leading-5 text-zinc-500">{policy.description}</p>
              </div>
            </div>
          ))}
        </RadioGroup>
        <p className="mt-4 flex items-start gap-2 rounded-lg border border-red-500/25 bg-red-500/5 p-3 text-xs leading-5 text-red-300">
          <TriangleAlert className="mt-0.5 size-4 shrink-0" />
          هشدار: در دو حالت دوم و سوم، سفارش‌های باز واقعاً در بازار بسته می‌شوند. حالت پیش‌فرض
          «halt» فقط کپی را متوقف می‌کند و هیچ پوزیشنی را نمی‌بندد.
        </p>
      </SectionCard>

      {/* sync on start */}
      <SectionCard
        title="سیاست همگام‌سازی هنگام شروع موتور"
        description="هنگام راه‌اندازی موتور، مغایرت پوزیشن‌های اسلیو چگونه رسیدگی شود"
      >
        <div className="max-w-md">
          <Select value={draft.syncOnStart} onValueChange={(v) => set("syncOnStart", v as SyncPolicy)}>
            <SelectTrigger className="h-11! w-full sm:h-9!" aria-label="سیاست همگام‌سازی اولیه">
              <SelectValue />
            </SelectTrigger>
            <SelectContent className="border-zinc-800 bg-zinc-900">
              {SYNC_POLICIES.map((policy) => (
                <SelectItem key={policy.value} value={policy.value}>
                  {policy.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <p className="mt-3 text-xs leading-5 text-zinc-500">
          {SYNC_POLICIES.find((p) => p.value === draft.syncOnStart)?.hint}
        </p>
        <p className="mt-2 text-[11px] leading-5 text-zinc-600">
          توجه: بدون انتخاب صریح سیاست خودکار، موتور هرگز پوزیشن جدیدی را به‌خودی‌خود باز نمی‌کند.
        </p>
      </SectionCard>

      {/* master auto trade (simulator) */}
      <SectionCard
        title="معامله‌گر خودکار مستر (شبیه‌ساز)"
        description="برای تست موتور، مستر به‌صورت دوره‌ای معامله آزمایشی باز و بسته می‌کند"
      >
        <div className="flex flex-col gap-6">
          <div className="flex items-center justify-between gap-3 rounded-lg border border-zinc-800 bg-zinc-950/40 p-3">
            <div>
              <p className="text-sm text-zinc-200">فعال‌سازی معامله‌گر خودکار</p>
              <p className="mt-0.5 text-[11px] text-zinc-500">
                فقط در محیط شبیه‌سازی معنا دارد؛ روی ویندوز اثری ندارد.
              </p>
            </div>
            <Switch
              checked={draft.masterAutoTrade}
              onCheckedChange={(v) => set("masterAutoTrade", v)}
              aria-label="معامله‌گر خودکار مستر"
            />
          </div>
          <div>
            <div className="flex items-center justify-between text-xs text-zinc-400">
              <span>فاصله بین معاملات</span>
              <Mono className="text-zinc-200">{`${fmtLatin(draft.autoTradeIntervalMs, 0)}ms`}</Mono>
            </div>
            <Slider
              className="mt-3"
              value={[draft.autoTradeIntervalMs]}
              min={2000}
              max={60000}
              step={500}
              onValueChange={([v]) => set("autoTradeIntervalMs", v)}
              aria-label="فاصله معاملات خودکار"
            />
            <div className="mt-1 flex justify-between text-[10px] text-zinc-600" dir="ltr">
              <span>2000ms</span>
              <span>60000ms</span>
            </div>
          </div>
          <div>
            <div className="flex items-center justify-between text-xs text-zinc-400">
              <span>احتمال پیش‌فرض رد شدن سفارش اسلیوها</span>
              <Mono className="text-zinc-200">{`${Math.round(draft.defaultRejectProbability * 100)}%`}</Mono>
            </div>
            <Slider
              className="mt-3"
              value={[draft.defaultRejectProbability]}
              min={0}
              max={1}
              step={0.05}
              onValueChange={([v]) => set("defaultRejectProbability", v)}
              aria-label="احتمال پیش‌فرض رد شدن"
            />
          </div>
        </div>
      </SectionCard>

      {/* security */}
      <SectionCard
        title={
          <span className="flex items-center gap-2">
            <ShieldCheck className="size-4 text-emerald-500" />
            امنیت و ذخیره‌سازی
          </span>
        }
      >
        <ul className="flex flex-col gap-2 text-sm text-zinc-300">
          <li className="flex items-start gap-2">
            <Badge variant="outline" className="mt-0.5 border-zinc-800 text-[10px] text-zinc-500">۱</Badge>
            اتصال فقط از طریق ترمینال‌های MT5 لاگین‌شده انجام می‌شود.
          </li>
          <li className="flex items-start gap-2">
            <Badge variant="outline" className="mt-0.5 border-zinc-800 text-[10px] text-zinc-500">۲</Badge>
            هیچ رمز عبوری ذخیره یا منتقل نمی‌شود.
          </li>
          <li className="flex items-start gap-2">
            <Badge variant="outline" className="mt-0.5 border-zinc-800 text-[10px] text-zinc-500">۳</Badge>
            تمام داده‌ها فقط به‌صورت لوکال در پایگاه‌داده SQLite نگهداری می‌شوند.
          </li>
          <li className="flex items-start gap-2">
            <Badge variant="outline" className="mt-0.5 border-zinc-800 text-[10px] text-zinc-500">۴</Badge>
            در نسخه ویندوز، کلیدهای حساس با DPAPI رمزنگاری می‌شوند.
          </li>
        </ul>
        <div className="mt-4 flex items-center gap-2 rounded-lg border border-zinc-800 bg-zinc-950/60 p-3 text-xs">
          <Database className="size-4 shrink-0 text-zinc-500" />
          <span className="text-zinc-500">مسیر پایگاه‌داده:</span>
          <Mono className="truncate text-zinc-300">{dbPath ?? "data/copier.db (SQLite محلی)"}</Mono>
        </div>
      </SectionCard>

      {/* save */}
      <div className="sticky bottom-4 z-30 flex items-center justify-between gap-3 rounded-xl border border-zinc-800 bg-zinc-900/95 px-4 py-3 backdrop-blur">
        <Input
          className="hidden w-64 border-transparent bg-transparent text-xs text-zinc-600 sm:block"
          disabled
          value="تغییرات تا ذخیره اعمال نمی‌شوند"
          readOnly
          aria-hidden
        />
        <Button onClick={save} disabled={saving} className="ms-auto h-11 gap-1.5 sm:h-9">
          <Save className="size-4" />
          {saving ? "در حال ذخیره..." : "ذخیره تنظیمات"}
        </Button>
      </div>
    </div>
  );
}
