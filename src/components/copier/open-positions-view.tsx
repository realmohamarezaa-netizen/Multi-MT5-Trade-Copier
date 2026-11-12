"use client";

import { useMemo, useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Accordion,
  AccordionContent,
  AccordionItem,
  AccordionTrigger,
} from "@/components/ui/accordion";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Button } from "@/components/ui/button";
import { ListOrdered, TrendingUp } from "lucide-react";
import { cn } from "@/lib/utils";

import type { PositionDTO, SnapshotDTO } from "@/lib/types";
import {
  CopyOpChips,
} from "./relations-panel";
import {
  EmptyState,
  ErrorBanner,
  MonoChip,
  RoleBadge,
  SideBadge,
} from "./common";
import { FaDateTime, Mono, Num, ProfitNum, faCount } from "./format";
import { usePolling } from "./use-polling";

type Kind = "position" | "pending";
type SideFilter = "all" | "buy" | "sell";

function StatusCell({ position }: { position: PositionDTO }) {
  if (position.kind === "pending") {
    return (
      <Badge variant="outline" className="border-zinc-700 text-[10px] text-zinc-400">
        <Mono className="text-[10px]">{position.pendingType || "pending"}</Mono>
      </Badge>
    );
  }
  if (position.copiedByEngine) {
    return (
      <Badge variant="outline" className="border-emerald-500/30 bg-emerald-500/10 text-[11px] text-emerald-400">
        کپی‌شده از مستر
      </Badge>
    );
  }
  if (position.terminalRole === "master") {
    return (
      <Badge variant="outline" className="border-amber-500/30 bg-amber-500/10 text-[11px] text-amber-400">
        مستر
      </Badge>
    );
  }
  return (
    <Badge variant="outline" className="border-zinc-800 text-[11px] text-zinc-500">
      محلی
    </Badge>
  );
}

export function OpenPositionsView() {
  const [kind, setKind] = useState<Kind>("position");
  const [account, setAccount] = useState<string>("all");
  const [symbol, setSymbol] = useState("");
  const [side, setSide] = useState<SideFilter>("all");

  const { data: snapshot, error: stateError, refresh: refreshState } = usePolling<SnapshotDTO>(
    "/api/state",
    3000
  );

  const positionsUrl = useMemo(() => {
    const params = new URLSearchParams({ kind });
    if (account !== "all") params.set("terminalId", account);
    return `/api/positions?${params.toString()}`;
  }, [kind, account]);

  const {
    data: positions,
    error,
    loading,
    refresh,
  } = usePolling<PositionDTO[]>(positionsUrl, 2000);

  const terminals = snapshot?.terminals ?? [];

  const filtered = useMemo(() => {
    const rows = positions ?? [];
    const sym = symbol.trim().toUpperCase();
    return rows
      .filter((p) => (side === "all" ? true : p.side === side))
      .filter((p) => (sym ? p.symbol.toUpperCase().includes(sym) : true))
      .sort((a, b) => b.openTime - a.openTime);
  }, [positions, symbol, side]);

  const hasFilter = account !== "all" || symbol.trim() !== "" || side !== "all";

  return (
    <div className="flex flex-col gap-6">
      <div>
        <h1 className="flex items-center gap-2 text-lg font-bold text-zinc-100">
          <TrendingUp className="size-5 text-amber-500" />
          {kind === "position" ? "پوزیشن‌های باز" : "سفارش‌های Pending"}
        </h1>
        <p className="mt-1 text-xs text-zinc-500">
          همه پوزیشن‌ها و سفارش‌های فعال ترمینال‌ها با وضعیت کپی
        </p>
      </div>

      {/* filters */}
      <div className="grid grid-cols-2 gap-3 rounded-xl border border-zinc-800 bg-zinc-900/60 p-4 lg:grid-cols-5">
        <div className="flex flex-col gap-1.5">
          <Label className="text-xs text-zinc-500">حساب</Label>
          <Select value={account} onValueChange={setAccount}>
            <SelectTrigger className="h-11! w-full sm:h-9!" aria-label="فیلتر حساب">
              <SelectValue />
            </SelectTrigger>
            <SelectContent className="border-zinc-800 bg-zinc-900">
              <SelectItem value="all">همه حساب‌ها</SelectItem>
              {terminals.map((t) => (
                <SelectItem key={t.id} value={t.id}>
                  {t.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="pos-symbol" className="text-xs text-zinc-500">نماد</Label>
          <Input
            id="pos-symbol"
            dir="ltr"
            className="text-start font-mono text-xs"
            placeholder="XAUUSD"
            value={symbol}
            onChange={(e) => setSymbol(e.target.value)}
          />
        </div>
        <div className="flex flex-col gap-1.5">
          <Label className="text-xs text-zinc-500">جهت</Label>
          <div className="flex overflow-hidden rounded-md border border-zinc-800">
            {(["all", "buy", "sell"] as const).map((option) => (
              <button
                key={option}
                type="button"
                onClick={() => setSide(option)}
                className={cn(
                  "h-11 min-w-11 flex-1 text-xs transition-colors sm:h-9",
                  side === option
                    ? option === "buy"
                      ? "bg-emerald-500/15 text-emerald-400"
                      : option === "sell"
                        ? "bg-red-500/15 text-red-400"
                        : "bg-zinc-800 text-zinc-200"
                    : "text-zinc-500 hover:text-zinc-300"
                )}
              >
                {option === "all" ? "همه" : option === "buy" ? "خرید" : "فروش"}
              </button>
            ))}
          </div>
        </div>
        <div className="flex flex-col gap-1.5">
          <Label className="text-xs text-zinc-500">نوع</Label>
          <div className="flex overflow-hidden rounded-md border border-zinc-800">
            {(["position", "pending"] as const).map((option) => (
              <button
                key={option}
                type="button"
                onClick={() => setKind(option)}
                className={cn(
                  "h-11 min-w-11 flex-1 text-xs transition-colors sm:h-9",
                  kind === option ? "bg-amber-500/15 text-amber-400" : "text-zinc-500 hover:text-zinc-300"
                )}
              >
                {option === "position" ? "پوزیشن" : "سفارش"}
              </button>
            ))}
          </div>
        </div>
        <div className="flex flex-col justify-end gap-1.5">
          <Button
            variant="outline"
            disabled={!hasFilter}
            onClick={() => {
              setAccount("all");
              setSymbol("");
              setSide("all");
            }}
            className="h-11 border-zinc-700 text-zinc-300 sm:h-9"
          >
            پاک‌سازی فیلترها
          </Button>
        </div>
      </div>

      {error && !positions ? (
        <ErrorBanner message={error} onRetry={refresh} />
      ) : loading && !positions ? (
        <div className="flex flex-col gap-2">
          {Array.from({ length: 6 }).map((_, i) => (
            <div key={i} className="h-10 animate-pulse rounded-lg bg-zinc-900/80" />
          ))}
        </div>
      ) : filtered.length === 0 ? (
        <EmptyState
          icon={<ListOrdered className="size-8" />}
          title={hasFilter ? "موردی مطابق فیلترها یافت نشد" : "پوزیشن بازی وجود ندارد"}
          hint={
            hasFilter
              ? "فیلترها را تغییر دهید یا پاک کنید."
              : "با باز شدن اولین معامله در مستر یا ترمینال‌ها، فهرست این‌جا زنده به‌روز می‌شود."
          }
        />
      ) : (
        <div className="max-h-[62vh] overflow-auto rounded-xl border border-zinc-800 bg-zinc-900/60">
          <Table>
            <TableHeader className="sticky top-0 z-10 bg-zinc-900">
              <TableRow className="border-zinc-800 hover:bg-transparent">
                <TableHead className="text-zinc-400">نماد</TableHead>
                <TableHead className="text-zinc-400">تیکت</TableHead>
                <TableHead className="text-zinc-400">حساب</TableHead>
                <TableHead className="text-zinc-400">جهت</TableHead>
                <TableHead className="text-zinc-400">Lot</TableHead>
                <TableHead className="text-zinc-400">قیمت ورود</TableHead>
                <TableHead className="text-zinc-400">قیمت فعلی</TableHead>
                <TableHead className="text-zinc-400">SL</TableHead>
                <TableHead className="text-zinc-400">TP</TableHead>
                <TableHead className="text-zinc-400">سود شناور</TableHead>
                <TableHead className="text-zinc-400">زمان باز شدن</TableHead>
                <TableHead className="text-zinc-400">وضعیت</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {filtered.map((p) => (
                <TableRow key={p.id} className="hover:bg-zinc-800/40">
                  <TableCell className="font-medium text-zinc-100">{p.symbol}</TableCell>
                  <TableCell>
                    <Mono className="text-xs text-zinc-400">{p.ticket}</Mono>
                  </TableCell>
                  <TableCell>
                    <div className="flex items-center gap-1.5">
                      <span className="text-xs text-zinc-300">{p.terminalName}</span>
                      <RoleBadge role={p.terminalRole} className="scale-90" />
                    </div>
                  </TableCell>
                  <TableCell><SideBadge side={p.side} /></TableCell>
                  <TableCell><Num value={p.volume} digits={2} className="text-zinc-300" /></TableCell>
                  <TableCell><Num value={p.openPrice} className="text-zinc-300" /></TableCell>
                  <TableCell><Num value={p.currentPrice} className="text-zinc-300" /></TableCell>
                  <TableCell>
                    {p.sl > 0 ? <Num value={p.sl} className="text-zinc-400" /> : <span className="text-zinc-600">—</span>}
                  </TableCell>
                  <TableCell>
                    {p.tp > 0 ? <Num value={p.tp} className="text-zinc-400" /> : <span className="text-zinc-600">—</span>}
                  </TableCell>
                  <TableCell><ProfitNum value={p.profit} className="text-sm" /></TableCell>
                  <TableCell className="whitespace-nowrap text-xs text-zinc-400">
                    <FaDateTime ts={p.openTime} />
                  </TableCell>
                  <TableCell><StatusCell position={p} /></TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      )}

      {/* relations accordion */}
      <section className="flex flex-col gap-3">
        <h2 className="flex items-center gap-2 text-sm font-semibold text-zinc-200">
          <ListOrdered className="size-4 text-amber-500" />
          رابطه معاملات مستر با کپی‌ها
        </h2>
        {(snapshot?.masterRelations ?? []).length === 0 ? (
          <EmptyState
            title="رابطه‌ای ثبت نشده است"
            hint="پس از باز شدن اولین معامله در مستر، وضعیت کپی آن برای هر اسلیو این‌جا نمایش داده می‌شود."
          />
        ) : (
          <Accordion type="multiple" className="rounded-xl border border-zinc-800 bg-zinc-900/60 px-4">
            {snapshot?.masterRelations.map((relation) => (
              <AccordionItem key={relation.masterTicket} value={relation.masterTicket} className="border-zinc-800">
                <AccordionTrigger className="py-3 text-start hover:no-underline">
                  <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-sm">
                    <span className="font-semibold text-zinc-100">{relation.symbol}</span>
                    <SideBadge side={relation.side} />
                    <Num value={relation.volume} digits={2} className="text-xs text-zinc-300" />
                    <MonoChip>{relation.masterTicket}</MonoChip>
                    {relation.isOpen ? (
                      <Badge variant="outline" className="border-emerald-500/30 text-[10px] text-emerald-400">
                        باز
                      </Badge>
                    ) : null}
                    <span className="text-xs text-zinc-500">
                      {faCount(relation.copies.length)} کپی
                    </span>
                  </div>
                </AccordionTrigger>
                <AccordionContent className="pb-4">
                  <CopyOpChips copies={relation.copies} />
                </AccordionContent>
              </AccordionItem>
            ))}
          </Accordion>
        )}
      </section>

      {stateError && snapshot ? (
        <p className="text-[11px] text-zinc-600">
          توجه: به‌روزرسانی وضعیت کلی موقتاً با خطا مواجه شد ({stateError})
        </p>
      ) : null}
    </div>
  );
}
