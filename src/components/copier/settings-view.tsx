"use client";

import { useEffect, useMemo, useState } from "react";
import { toast } from "sonner";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
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
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import { ChevronDown, Plus, Save, SlidersHorizontal, Trash2 } from "lucide-react";

import { cn } from "@/lib/utils";
import type { LotMode, SlaveSettingsDTO, SnapshotDTO, SyncPolicy } from "@/lib/types";
import { apiPut, errorMessage } from "./api";
import { ErrorBanner, PageSkeleton } from "./common";
import { Mono, faCount } from "./format";
import { usePolling } from "./use-polling";

const LOT_MODES: { value: LotMode; label: string; hint: string; field?: keyof SlaveSettingsDTO }[] = [
  { value: "same", label: "همان مستر", hint: "حجم دقیقاً برابر حجم معامله مستر" },
  { value: "fixed", label: "حجم ثابت", hint: "همیشه حجم ثابت", field: "fixedLot" },
  { value: "multiplier", label: "ضریب", hint: "حجم مستر × ضریب", field: "multiplier" },
  { value: "balance", label: "نسبت بالانس", hint: "متناسب با نسبت بالانس اسلیو به مستر", field: "balanceRatioCap" },
  { value: "risk", label: "ریسک-محور", hint: "بر پایه درصد ریسک از بالانس", field: "riskPercent" },
];

const SYNC_POLICIES: { value: SyncPolicy; label: string }[] = [
  { value: "report", label: "فقط گزارش" },
  { value: "autoOpenMissing", label: "باز کردن خودکار جاافتاده‌ها" },
  { value: "autoCloseExtra", label: "بستن خودکار اضافی‌ها" },
];

function defaultSettings(terminalId: string): SlaveSettingsDTO {
  return {
    terminalId,
    lotMode: "same",
    fixedLot: 0.1,
    multiplier: 1,
    balanceRatioCap: 1,
    riskPercent: 1,
    copySL: true,
    copyTP: true,
    copyModifications: true,
    copyPartialClose: true,
    copyPending: true,
    closeOnMasterClose: true,
    maxSpreadPoints: 50,
    maxLot: 10,
    maxPositions: 20,
    slippagePoints: 30,
    buyEnabled: true,
    sellEnabled: true,
    symbolWhitelist: "",
    symbolBlacklist: "",
    symbolMapping: "",
    syncPolicy: "report",
    rejectProbability: 0,
    baseLatencyMs: 60,
    jitterMs: 20,
  };
}

function parseMapping(raw: string): { from: string; to: string }[] {
  if (!raw) return [];
  return raw
    .split(";")
    .map((pair) => pair.split("="))
    .filter((parts) => parts.length === 2)
    .map(([from, to]) => ({ from: from.trim(), to: to.trim() }))
    .filter((row) => row.from.length > 0 || row.to.length > 0);
}

function serializeMapping(rows: { from: string; to: string }[]): string {
  return rows
    .filter((row) => row.from.trim().length > 0 && row.to.trim().length > 0)
    .map((row) => `${row.from.trim()}=${row.to.trim()}`)
    .join(";");
}

function NumberField({
  id,
  label,
  value,
  onChange,
  step = 1,
  min,
  max,
  hint,
}: {
  id: string;
  label: string;
  value: number;
  onChange: (next: number) => void;
  step?: number;
  min?: number;
  max?: number;
  hint?: string;
}) {
  return (
    <div className="flex flex-col gap-1.5">
      <Label htmlFor={id} className="text-xs text-zinc-400">{label}</Label>
      <Input
        id={id}
        type="number"
        dir="ltr"
        className="text-start font-mono"
        value={Number.isFinite(value) ? value : 0}
        step={step}
        min={min}
        max={max}
        onChange={(e) => {
          const next = e.target.valueAsNumber;
          if (Number.isFinite(next)) onChange(next);
        }}
      />
      {hint ? <p className="text-[11px] text-zinc-600">{hint}</p> : null}
    </div>
  );
}

function CheckField({
  id,
  label,
  checked,
  onChange,
}: {
  id: string;
  label: string;
  checked: boolean;
  onChange: (next: boolean) => void;
}) {
  return (
    <label
      htmlFor={id}
      className="flex min-h-11 cursor-pointer items-center gap-2.5 rounded-lg border border-zinc-800 bg-zinc-950/40 px-3 text-sm text-zinc-300 transition-colors hover:bg-zinc-900 sm:min-h-0 sm:border-0 sm:bg-transparent sm:px-0"
    >
      <Checkbox id={id} checked={checked} onCheckedChange={(v) => onChange(v === true)} />
      {label}
    </label>
  );
}

function SwitchField({
  id,
  label,
  checked,
  onChange,
}: {
  id: string;
  label: string;
  checked: boolean;
  onChange: (next: boolean) => void;
}) {
  return (
    <div className="flex min-h-11 items-center justify-between gap-3 rounded-lg border border-zinc-800 bg-zinc-950/40 px-3 sm:min-h-0 sm:border-0 sm:bg-transparent sm:px-0">
      <Label htmlFor={id} className="text-sm text-zinc-300">{label}</Label>
      <Switch id={id} checked={checked} onCheckedChange={onChange} />
    </div>
  );
}

export function SettingsView() {
  const { data, error, loading, refresh } = usePolling<SnapshotDTO>("/api/state", 2500);
  const slaves = useMemo(
    () => (data?.terminals ?? []).filter((t) => t.role === "slave"),
    [data?.terminals]
  );
  const [selectedId, setSelectedId] = useState<string>("");
  const [draft, setDraft] = useState<SlaveSettingsDTO | null>(null);
  const [mappingRows, setMappingRows] = useState<{ from: string; to: string }[]>([]);
  const [saving, setSaving] = useState(false);
  const [advancedOpen, setAdvancedOpen] = useState(false);

  const effectiveId =
    slaves.find((s) => s.id === selectedId)?.id ?? slaves[0]?.id ?? "";
  const selected = slaves.find((s) => s.id === effectiveId) ?? null;

  // (re)load the draft whenever the selected slave changes
  useEffect(() => {
    if (!selected) {
      setDraft(null);
      setMappingRows([]);
      return;
    }
    const settings = selected.settings ?? defaultSettings(selected.id);
    setDraft({ ...settings });
    setMappingRows(parseMapping(settings.symbolMapping));
  }, [selected?.id]);  

  if (loading && !data) return <PageSkeleton cards={3} />;
  if (error && !data) return <ErrorBanner message={error} onRetry={refresh} className="mb-6" />;
  if (!data) return null;

  if (slaves.length === 0) {
    return (
      <div className="flex flex-col gap-6">
        <div>
          <h1 className="flex items-center gap-2 text-lg font-bold text-zinc-100">
            <SlidersHorizontal className="size-5 text-amber-500" />
            تنظیمات کپی
          </h1>
          <p className="mt-1 text-xs text-zinc-500">پیکربندی کامل رفتار کپی برای هر اسلیو</p>
        </div>
        <div className="rounded-xl border border-dashed border-zinc-800 bg-zinc-900/40 px-6 py-12 text-center">
          <p className="text-sm text-zinc-300">هیچ اسلیوی تعریف نشده است</p>
          <p className="mx-auto mt-2 max-w-md text-xs leading-5 text-zinc-500">
            ابتدا در تب «مستر و اسلیوها» به یک ترمینال نقش «اسلیو» بدهید؛ سپس تنظیمات کامل کپی برای آن
            در همین بخش ظاهر می‌شود.
          </p>
        </div>
      </div>
    );
  }

  const set = <K extends keyof SlaveSettingsDTO>(key: K, value: SlaveSettingsDTO[K]) => {
    setDraft((prev) => (prev ? { ...prev, [key]: value } : prev));
  };

  const save = async () => {
    if (!draft || !selected) return;
    setSaving(true);
    try {
      const payload: SlaveSettingsDTO = {
        ...draft,
        terminalId: selected.id,
        symbolMapping: serializeMapping(mappingRows),
      };
      await apiPut(`/api/terminals/${selected.id}/settings`, payload);
      toast.success(`تنظیمات «${selected.name}» ذخیره شد`);
      refresh();
    } catch (err) {
      toast.error(errorMessage(err, "ذخیره تنظیمات ناموفق بود"));
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="flex items-center gap-2 text-lg font-bold text-zinc-100">
            <SlidersHorizontal className="size-5 text-amber-500" />
            تنظیمات کپی
          </h1>
          <p className="mt-1 text-xs text-zinc-500">پیکربندی کامل رفتار کپی برای هر اسلیو</p>
        </div>
        <Select value={effectiveId} onValueChange={setSelectedId}>
          <SelectTrigger className="h-11! w-56 sm:h-9!" aria-label="انتخاب اسلیو">
            <SelectValue placeholder="انتخاب اسلیو" />
          </SelectTrigger>
          <SelectContent className="border-zinc-800 bg-zinc-900">
            {slaves.map((s) => (
              <SelectItem key={s.id} value={s.id}>
                {s.name}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      {draft && selected ? (
        <div className="flex flex-col gap-6">
          {/* lot mode */}
          <section className="rounded-xl border border-zinc-800 bg-zinc-900/60 p-4 sm:p-6">
            <h2 className="text-sm font-semibold text-zinc-200">مدل حجم (Lot)</h2>
            <RadioGroup
              value={draft.lotMode}
              onValueChange={(v) => set("lotMode", v as LotMode)}
              className="mt-4 grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-3"
            >
              {LOT_MODES.map((mode) => (
                <div key={mode.value} className="flex items-start gap-2.5 rounded-lg border border-zinc-800 bg-zinc-950/40 p-3">
                  <RadioGroupItem value={mode.value} id={`lot-${mode.value}`} className="mt-0.5" />
                  <div className="min-w-0">
                    <Label htmlFor={`lot-${mode.value}`} className="cursor-pointer text-sm text-zinc-200">
                      {mode.label}
                    </Label>
                    <p className="mt-1 text-[11px] leading-4 text-zinc-500">{mode.hint}</p>
                  </div>
                </div>
              ))}
            </RadioGroup>
            {draft.lotMode === "fixed" ? (
              <div className="mt-4 max-w-xs">
                <NumberField id="fixedLot" label="حجم ثابت" value={draft.fixedLot} step={0.01} min={0} onChange={(v) => set("fixedLot", v)} />
              </div>
            ) : null}
            {draft.lotMode === "multiplier" ? (
              <div className="mt-4 max-w-xs">
                <NumberField id="multiplier" label="ضریب حجم" value={draft.multiplier} step={0.1} min={0} onChange={(v) => set("multiplier", v)} />
              </div>
            ) : null}
            {draft.lotMode === "balance" ? (
              <div className="mt-4 max-w-xs">
                <NumberField
                  id="balanceRatioCap"
                  label="سقف نسبت بالانس"
                  value={draft.balanceRatioCap}
                  step={0.1}
                  min={0}
                  hint="اگر نسبت بالانس اسلیو به مستر از این سقف بیشتر شود، همین سقف اعمال می‌شود."
                  onChange={(v) => set("balanceRatioCap", v)}
                />
              </div>
            ) : null}
            {draft.lotMode === "risk" ? (
              <div className="mt-4 max-w-xs">
                <NumberField
                  id="riskPercent"
                  label="درصد ریسک از بالانس"
                  value={draft.riskPercent}
                  step={0.1}
                  min={0}
                  max={100}
                  onChange={(v) => set("riskPercent", v)}
                />
              </div>
            ) : null}
          </section>

          {/* copy behaviors */}
          <section className="rounded-xl border border-zinc-800 bg-zinc-900/60 p-4 sm:p-6">
            <h2 className="text-sm font-semibold text-zinc-200">رفتار کپی</h2>
            <div className="mt-4 grid grid-cols-1 gap-x-8 gap-y-1 sm:grid-cols-2 xl:grid-cols-3">
              <CheckField id="copySL" label="کپی حد ضرر (SL)" checked={draft.copySL} onChange={(v) => set("copySL", v)} />
              <CheckField id="copyTP" label="کپی حد سود (TP)" checked={draft.copyTP} onChange={(v) => set("copyTP", v)} />
              <CheckField id="copyMods" label="کپی تغییرات SL/TP" checked={draft.copyModifications} onChange={(v) => set("copyModifications", v)} />
              <CheckField id="copyPartial" label="کپی Partial Close" checked={draft.copyPartialClose} onChange={(v) => set("copyPartialClose", v)} />
              <CheckField id="copyPending" label="کپی سفارش‌های Pending" checked={draft.copyPending} onChange={(v) => set("copyPending", v)} />
              <CheckField id="closeOnMaster" label="بستن هنگام بسته‌شدن مستر" checked={draft.closeOnMasterClose} onChange={(v) => set("closeOnMasterClose", v)} />
            </div>
          </section>

          {/* limits */}
          <section className="rounded-xl border border-zinc-800 bg-zinc-900/60 p-4 sm:p-6">
            <h2 className="text-sm font-semibold text-zinc-200">محدودیت‌ها</h2>
            <div className="mt-4 grid grid-cols-2 gap-4 xl:grid-cols-4">
              <NumberField id="maxSpread" label="حداکثر اسپرد (پوینت)" value={draft.maxSpreadPoints} min={0} onChange={(v) => set("maxSpreadPoints", v)} />
              <NumberField id="maxLot" label="حداکثر حجم (Lot)" value={draft.maxLot} step={0.1} min={0} onChange={(v) => set("maxLot", v)} />
              <NumberField id="maxPositions" label="حداکثر پوزیشن" value={draft.maxPositions} min={0} onChange={(v) => set("maxPositions", v)} />
              <NumberField id="slippage" label="Slippage (پوینت)" value={draft.slippagePoints} min={0} onChange={(v) => set("slippagePoints", v)} />
            </div>
          </section>

          {/* direction filters + symbol filters */}
          <section className="rounded-xl border border-zinc-800 bg-zinc-900/60 p-4 sm:p-6">
            <h2 className="text-sm font-semibold text-zinc-200">فیلترها</h2>
            <div className="mt-4 grid grid-cols-1 gap-x-8 gap-y-1 sm:grid-cols-2">
              <SwitchField id="buyEnabled" label="اجازه خرید (Buy)" checked={draft.buyEnabled} onChange={(v) => set("buyEnabled", v)} />
              <SwitchField id="sellEnabled" label="اجازه فروش (Sell)" checked={draft.sellEnabled} onChange={(v) => set("sellEnabled", v)} />
            </div>
            <div className="mt-4 grid grid-cols-1 gap-4 sm:grid-cols-2">
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="whitelist" className="text-xs text-zinc-400">
                  لیست سفید نمادها (با کاما جدا کنید)
                </Label>
                <Input
                  id="whitelist"
                  dir="ltr"
                  className="text-start font-mono text-xs"
                  placeholder="XAUUSD, EURUSD"
                  value={draft.symbolWhitelist}
                  onChange={(e) => set("symbolWhitelist", e.target.value)}
                />
                <p className="text-[11px] text-zinc-600">خالی = همه نمادها مجاز</p>
              </div>
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="blacklist" className="text-xs text-zinc-400">
                  لیست سیاه نمادها (با کاما جدا کنید)
                </Label>
                <Input
                  id="blacklist"
                  dir="ltr"
                  className="text-start font-mono text-xs"
                  placeholder="BTCUSD"
                  value={draft.symbolBlacklist}
                  onChange={(e) => set("symbolBlacklist", e.target.value)}
                />
              </div>
            </div>
          </section>

          {/* symbol mapping */}
          <section className="rounded-xl border border-zinc-800 bg-zinc-900/60 p-4 sm:p-6">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <h2 className="text-sm font-semibold text-zinc-200">نگاشت نمادها</h2>
              <Badge variant="outline" className="border-zinc-800 text-[10px] text-zinc-500">
                مثال: XAUUSD=GOLD
              </Badge>
            </div>
            <p className="mt-1 text-[11px] text-zinc-500">
              اگر نام نماد در اسلیو متفاوت است، اینجا نگاشت کنید (ذخیره به‌صورت <Mono>A=B;C=D</Mono>).
            </p>
            <div className="mt-4 flex flex-col gap-2">
              {mappingRows.map((row, index) => (
                <div key={index} className="flex items-center gap-2">
                  <Input
                    dir="ltr"
                    aria-label={`نماد مستر ${faCount(index + 1)}`}
                    className="h-11 text-start font-mono text-xs sm:h-9"
                    placeholder="XAUUSD (مستر)"
                    value={row.from}
                    onChange={(e) => {
                      const next = [...mappingRows];
                      next[index] = { ...next[index], from: e.target.value };
                      setMappingRows(next);
                    }}
                  />
                  <span className="shrink-0 text-xs text-zinc-600">→</span>
                  <Input
                    dir="ltr"
                    aria-label={`نماد اسلیو ${faCount(index + 1)}`}
                    className="h-11 text-start font-mono text-xs sm:h-9"
                    placeholder="GOLD (اسلیو)"
                    value={row.to}
                    onChange={(e) => {
                      const next = [...mappingRows];
                      next[index] = { ...next[index], to: e.target.value };
                      setMappingRows(next);
                    }}
                  />
                  <Button
                    variant="ghost"
                    size="icon"
                    aria-label="حذف نگاشت"
                    className="size-11 shrink-0 text-zinc-500 hover:text-red-400 sm:size-9"
                    onClick={() => setMappingRows(mappingRows.filter((_, i) => i !== index))}
                  >
                    <Trash2 className="size-4" />
                  </Button>
                </div>
              ))}
              <Button
                variant="outline"
                onClick={() => setMappingRows([...mappingRows, { from: "", to: "" }])}
                className="h-11 w-fit gap-1.5 border-zinc-700 text-zinc-300 sm:h-9"
              >
                <Plus className="size-4" />
                افزودن نگاشت
              </Button>
            </div>
          </section>

          {/* sync policy */}
          <section className="rounded-xl border border-zinc-800 bg-zinc-900/60 p-4 sm:p-6">
            <h2 className="text-sm font-semibold text-zinc-200">سیاست همگام‌سازی مغایرت‌ها</h2>
            <div className="mt-4 max-w-sm">
              <Select value={draft.syncPolicy} onValueChange={(v) => set("syncPolicy", v as SyncPolicy)}>
                <SelectTrigger className="h-11! w-full sm:h-9!" aria-label="سیاست همگام‌سازی">
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
            <p className="mt-3 rounded-lg border border-amber-500/20 bg-amber-500/5 p-3 text-xs leading-5 text-amber-300/80">
              در حالت پیش‌فرض «فقط گزارش» هیچ پوزیشنی به‌صورت خودکار باز نمی‌شود؛ مغایرت‌ها فقط در لاگ
              و داشبورد گزارش می‌شوند. حالت‌های خودکار فقط با انتخاب صریح شما فعال می‌گردند.
            </p>
          </section>

          {/* advanced (simulator realism) */}
          <Collapsible open={advancedOpen} onOpenChange={setAdvancedOpen}>
            <section className="rounded-xl border border-zinc-800 bg-zinc-900/60 p-4 sm:p-6">
              <CollapsibleTrigger className="flex w-full items-center justify-between gap-2 text-start">
                <div>
                  <h2 className="text-sm font-semibold text-zinc-200">پیشرفته (شبیه‌سازی)</h2>
                  <p className="mt-0.5 text-[11px] text-zinc-500">
                    شبیه‌سازی واقع‌گرایانه ردشدگی و تأخیر بروکر — روی ویندوز واقعی اثر ندارد
                  </p>
                </div>
                <ChevronDown className={cn("size-4 shrink-0 text-zinc-500 transition-transform", advancedOpen && "rotate-180")} />
              </CollapsibleTrigger>
              <CollapsibleContent>
                <div className="mt-5 flex flex-col gap-6">
                  <div>
                    <div className="flex items-center justify-between text-xs text-zinc-400">
                      <span>احتمال رد شدن سفارش (Reject)</span>
                      <Mono className="text-zinc-200">{`${Math.round(draft.rejectProbability * 100)}%`}</Mono>
                    </div>
                    <Slider
                      className="mt-3"
                      value={[draft.rejectProbability]}
                      min={0}
                      max={1}
                      step={0.05}
                      onValueChange={([v]) => set("rejectProbability", v)}
                      aria-label="احتمال رد شدن سفارش"
                    />
                  </div>
                  <div className="grid grid-cols-2 gap-4">
                    <NumberField
                      id="baseLatency"
                      label="تأخیر پایه (ms)"
                      value={draft.baseLatencyMs}
                      step={10}
                      min={0}
                      onChange={(v) => set("baseLatencyMs", v)}
                    />
                    <NumberField
                      id="jitter"
                      label="Jitter تأخیر (ms)"
                      value={draft.jitterMs}
                      step={10}
                      min={0}
                      onChange={(v) => set("jitterMs", v)}
                    />
                  </div>
                </div>
              </CollapsibleContent>
            </section>
          </Collapsible>

          {/* save bar */}
          <div className="sticky bottom-4 z-30 flex items-center justify-between gap-3 rounded-xl border border-zinc-800 bg-zinc-900/95 px-4 py-3 backdrop-blur">
            <p className="truncate text-xs text-zinc-500">
              ویرایش تنظیمات «{selected.name}» — تغییرات تا ذخیره اعمال نمی‌شود.
            </p>
            <Button onClick={save} disabled={saving} className="h-11 shrink-0 gap-1.5 sm:h-9">
              <Save className="size-4" />
              {saving ? "در حال ذخیره..." : "ذخیره تنظیمات"}
            </Button>
          </div>
        </div>
      ) : (
        <div className="rounded-xl border border-zinc-800 bg-zinc-900/60 p-6 text-sm text-zinc-400">
          در حال دریافت تنظیمات اسلیو...
        </div>
      )}
    </div>
  );
}
