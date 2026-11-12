"use client";

import { useMemo, useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
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
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Archive, Search } from "lucide-react";
import { cn } from "@/lib/utils";

import type { ClosedTradeDTO, MasterTradeRelationDTO, SnapshotDTO } from "@/lib/types";
import { CopyOpChips } from "./relations-panel";
import {
  EmptyState,
  ErrorBanner,
  MonoChip,
  RoleBadge,
  SideBadge,
  closeReasonBadgeClass,
  closeReasonLabel,
} from "./common";
import { FaDateTime, Mono, Num, ProfitNum } from "./format";
import { usePolling } from "./use-polling";

function buildQuery(params: Record<string, string>): string {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value) search.set(key, value);
  }
  const qs = search.toString();
  return qs ? `?${qs}` : "";
}

export function ClosedPositionsView() {
  const [terminalId, setTerminalId] = useState("all");
  const [symbol, setSymbol] = useState("");
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [reason, setReason] = useState("all");
  const [q, setQ] = useState("");

  const url = useMemo(() => {
    const params: Record<string, string> = { limit: "200" };
    if (terminalId !== "all") params.terminalId = terminalId;
    if (symbol.trim()) params.symbol = symbol.trim();
    if (from) params.from = from;
    if (to) params.to = to;
    if (reason !== "all") params.reason = reason;
    if (q.trim()) params.q = q.trim();
    return `/api/closed${buildQuery(params)}`;
  }, [terminalId, symbol, from, to, reason, q]);

  const { data: snapshot } = usePolling<SnapshotDTO>("/api/state", 3000);
  const { data: trades, error, loading, refresh } = usePolling<ClosedTradeDTO[]>(url, 2500);

  const terminals = snapshot?.terminals ?? [];
  const relationsByTicket = useMemo(() => {
    const map = new Map<string, MasterTradeRelationDTO>();
    for (const relation of snapshot?.masterRelations ?? []) {
      if (!relation.isOpen) map.set(relation.masterTicket, relation);
    }
    return map;
  }, [snapshot?.masterRelations]);

  const rows = trades ?? [];
  const summary = useMemo(() => {
    let total = 0;
    let wins = 0;
    let losses = 0;
    for (const t of rows) {
      total += t.profit;
      if (t.profit > 0) wins += 1;
      else if (t.profit < 0) losses += 1;
    }
    return { total, wins, losses, count: rows.length };
  }, [rows]);

  const hasFilter =
    terminalId !== "all" ||
    symbol.trim() !== "" ||
    from !== "" ||
    to !== "" ||
    reason !== "all" ||
    q.trim() !== "";

  const resetFilters = () => {
    setTerminalId("all");
    setSymbol("");
    setFrom("");
    setTo("");
    setReason("all");
    setQ("");
  };

  return (
    <div className="flex flex-col gap-6">
      <div>
        <h1 className="flex items-center gap-2 text-lg font-bold text-zinc-100">
          <Archive className="size-5 text-amber-500" />
          پوزیشن‌های بسته‌شده
        </h1>
        <p className="mt-1 text-xs text-zinc-500">
          تاریخچه معاملات بسته‌شده با علت بستن و وضعیت کپی نسبت به مستر
        </p>
      </div>

      {/* filters */}
      <div className="grid grid-cols-2 gap-3 rounded-xl border border-zinc-800 bg-zinc-900/60 p-4 md:grid-cols-3 xl:grid-cols-7">
        <div className="flex flex-col gap-1.5">
          <Label className="text-xs text-zinc-500">حساب</Label>
          <Select value={terminalId} onValueChange={setTerminalId}>
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
          <Label htmlFor="closed-symbol" className="text-xs text-zinc-500">نماد</Label>
          <Input
            id="closed-symbol"
            dir="ltr"
            className="text-start font-mono text-xs"
            placeholder="XAUUSD"
            value={symbol}
            onChange={(e) => setSymbol(e.target.value)}
          />
        </div>
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="closed-from" className="text-xs text-zinc-500">از تاریخ</Label>
          <Input
            id="closed-from"
            type="date"
            dir="ltr"
            className="text-start font-mono text-xs [color-scheme:dark]"
            value={from}
            onChange={(e) => setFrom(e.target.value)}
          />
        </div>
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="closed-to" className="text-xs text-zinc-500">تا تاریخ</Label>
          <Input
            id="closed-to"
            type="date"
            dir="ltr"
            className="text-start font-mono text-xs [color-scheme:dark]"
            value={to}
            onChange={(e) => setTo(e.target.value)}
          />
        </div>
        <div className="flex flex-col gap-1.5">
          <Label className="text-xs text-zinc-500">علت بستن</Label>
          <Select value={reason} onValueChange={setReason}>
            <SelectTrigger className="h-11! w-full sm:h-9!" aria-label="فیلتر علت بستن">
              <SelectValue />
            </SelectTrigger>
            <SelectContent className="border-zinc-800 bg-zinc-900">
              <SelectItem value="all">همه</SelectItem>
              <SelectItem value="manual">دستی</SelectItem>
              <SelectItem value="sl">استاپ‌لاس</SelectItem>
              <SelectItem value="tp">تیک‌پرافیت</SelectItem>
              <SelectItem value="engine">موتور</SelectItem>
            </SelectContent>
          </Select>
        </div>
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="closed-q" className="text-xs text-zinc-500">جستجو</Label>
          <div className="relative">
            <Search className="absolute top-1/2 end-2.5 size-3.5 -translate-y-1/2 text-zinc-600" />
            <Input
              id="closed-q"
              dir="ltr"
              className="pe-8 text-start font-mono text-xs"
              placeholder="تیکت یا نماد"
              value={q}
              onChange={(e) => setQ(e.target.value)}
            />
          </div>
        </div>
        <div className="flex flex-col justify-end gap-1.5">
          <Button
            variant="outline"
            disabled={!hasFilter}
            onClick={resetFilters}
            className="h-11 border-zinc-700 text-zinc-300 sm:h-9"
          >
            پاک‌سازی فیلترها
          </Button>
        </div>
      </div>

      {/* summary strip */}
      <div className="flex flex-wrap items-center gap-x-6 gap-y-2 rounded-xl border border-zinc-800 bg-zinc-900/60 px-4 py-3 text-sm">
        <span className="text-zinc-500">
          تعداد: <span className="tnum text-zinc-200">{summary.count.toLocaleString("fa-IR")}</span>
        </span>
        <span className="text-zinc-500">
          جمع سود/زیان: <ProfitNum value={summary.total} />
        </span>
        <span className="text-zinc-500">
          سودده: <span className="tnum text-emerald-500">{summary.wins.toLocaleString("fa-IR")}</span>
        </span>
        <span className="text-zinc-500">
          زیان‌ده: <span className="tnum text-red-500">{summary.losses.toLocaleString("fa-IR")}</span>
        </span>
      </div>

      {error && !trades ? (
        <ErrorBanner message={error} onRetry={refresh} />
      ) : loading && !trades ? (
        <div className="flex flex-col gap-2">
          {Array.from({ length: 6 }).map((_, i) => (
            <div key={i} className="h-10 animate-pulse rounded-lg bg-zinc-900/80" />
          ))}
        </div>
      ) : rows.length === 0 ? (
        <EmptyState
          icon={<Archive className="size-8" />}
          title={hasFilter ? "معامله بسته‌شده‌ای مطابق فیلترها یافت نشد" : "هنوز معامله‌ای بسته نشده است"}
          hint={
            hasFilter
              ? "بازه تاریخ یا فیلترها را تغییر دهید."
              : "پس از بسته شدن اولین معامله (دستی، SL، TP یا موتور)، این‌جا ثبت می‌شود."
          }
        />
      ) : (
        <div className="max-h-[62vh] overflow-auto rounded-xl border border-zinc-800 bg-zinc-900/60">
          <Table>
            <TableHeader className="sticky top-0 z-10 bg-zinc-900">
              <TableRow className="border-zinc-800 hover:bg-transparent">
                <TableHead className="text-zinc-400">نماد</TableHead>
                <TableHead className="text-zinc-400">نوع</TableHead>
                <TableHead className="text-zinc-400">Lot</TableHead>
                <TableHead className="text-zinc-400">قیمت ورود</TableHead>
                <TableHead className="text-zinc-400">قیمت بستن</TableHead>
                <TableHead className="text-zinc-400">زمان باز</TableHead>
                <TableHead className="text-zinc-400">زمان بستن</TableHead>
                <TableHead className="text-zinc-400">سود/زیان</TableHead>
                <TableHead className="text-zinc-400">علت بستن</TableHead>
                <TableHead className="text-zinc-400">ارتباط با مستر</TableHead>
                <TableHead className="min-w-[240px] text-zinc-400">وضعیت کپی</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.map((trade) => {
                const relation = relationsByTicket.get(trade.masterTicket);
                const isMasterOwn = trade.terminalRole === "master";
                return (
                  <TableRow key={trade.id} className="hover:bg-zinc-800/40">
                    <TableCell className="font-medium text-zinc-100">{trade.symbol}</TableCell>
                    <TableCell>
                      <div className="flex items-center gap-1.5">
                        <SideBadge side={trade.side} />
                        <span className="text-[10px] text-zinc-600">{trade.kind}</span>
                      </div>
                    </TableCell>
                    <TableCell><Num value={trade.volume} digits={2} className="text-zinc-300" /></TableCell>
                    <TableCell><Num value={trade.openPrice} className="text-zinc-300" /></TableCell>
                    <TableCell><Num value={trade.closePrice} className="text-zinc-300" /></TableCell>
                    <TableCell className="whitespace-nowrap text-xs text-zinc-400">
                      <FaDateTime ts={trade.openTime} />
                    </TableCell>
                    <TableCell className="whitespace-nowrap text-xs text-zinc-400">
                      <FaDateTime ts={trade.closeTime} />
                    </TableCell>
                    <TableCell><ProfitNum value={trade.profit} className="text-sm" /></TableCell>
                    <TableCell>
                      <Badge
                        variant="outline"
                        className={cn("text-[11px]", closeReasonBadgeClass(trade.closeReason))}
                      >
                        {closeReasonLabel(trade.closeReason)}
                      </Badge>
                    </TableCell>
                    <TableCell>
                      {isMasterOwn ? (
                        <Badge variant="outline" className="border-amber-500/40 bg-amber-500/10 text-[11px] text-amber-400">
                          مستر · <Mono className="text-[10px]">{trade.ticket}</Mono>
                        </Badge>
                      ) : trade.masterTicket ? (
                        <div className="flex items-center gap-1.5">
                          <MonoChip>{trade.masterTicket}</MonoChip>
                          <RoleBadge role={trade.terminalRole} className="scale-90" />
                        </div>
                      ) : (
                        <span className="text-xs text-zinc-600">مستقل</span>
                      )}
                    </TableCell>
                    <TableCell>
                      {relation ? (
                        <CopyOpChips copies={relation.copies} />
                      ) : trade.masterTicket ? (
                        <span className="text-xs text-zinc-600">
                          فقط تیکت مستر در دسترس است
                        </span>
                      ) : (
                        <span className="text-xs text-zinc-600">—</span>
                      )}
                    </TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        </div>
      )}
    </div>
  );
}
