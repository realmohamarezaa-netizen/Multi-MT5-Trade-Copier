"use client";

import { Fragment, useEffect, useMemo, useState } from "react";
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
import { Switch } from "@/components/ui/switch";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import {
  ChevronDown,
  Download,
  Eraser,
  ScrollText,
} from "lucide-react";
import { cn } from "@/lib/utils";

import type { LogDTO, SnapshotDTO } from "@/lib/types";
import { EmptyState, ErrorBanner, LOG_LEVEL_META } from "./common";
import { FaDateTime, Mono, RelativeTime } from "./format";
import { usePolling } from "./use-polling";

type LogLevel = "info" | "success" | "warn" | "error";
const ALL_LEVELS: LogLevel[] = ["info", "success", "warn", "error"];

function prettyDetails(raw: string): string {
  try {
    return JSON.stringify(JSON.parse(raw), null, 2);
  } catch {
    return raw;
  }
}

export function LogsView() {
  const [levels, setLevels] = useState<Set<LogLevel>>(() => new Set(ALL_LEVELS));
  const [category, setCategory] = useState("all");
  const [terminalId, setTerminalId] = useState("all");
  const [q, setQ] = useState("");
  const [live, setLive] = useState(true);
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set());

  const { data: snapshot } = usePolling<SnapshotDTO>("/api/state", 3000);

  const url = useMemo(() => {
    const params = new URLSearchParams();
    if (levels.size > 0 && levels.size < ALL_LEVELS.length) {
      params.set("level", ALL_LEVELS.filter((l) => levels.has(l)).join(","));
    }
    if (terminalId !== "all") params.set("terminalId", terminalId);
    if (q.trim()) params.set("q", q.trim());
    params.set("limit", "200");
    return `/api/logs?${params.toString()}`;
  }, [levels, terminalId, q]);

  const { data: logs, error, loading, refresh } = usePolling<LogDTO[]>(url, 2500, live);

  const categories = useMemo(() => {
    const set = new Set<string>();
    for (const log of logs ?? []) {
      if (log.category) set.add(log.category);
    }
    return Array.from(set).sort();
  }, [logs]);

  const rows = useMemo(() => {
    const list = logs ?? [];
    const filtered = list.filter((log) => {
      if (!levels.has(log.level)) return false;
      if (category !== "all" && log.category !== category) return false;
      return true;
    });
    return filtered.sort((a, b) => b.ts - a.ts);
  }, [logs, levels, category]);

  const hasFilter =
    levels.size !== ALL_LEVELS.length || category !== "all" || terminalId !== "all" || q.trim() !== "";

  const resetFilters = () => {
    setLevels(new Set(ALL_LEVELS));
    setCategory("all");
    setTerminalId("all");
    setQ("");
  };

  const toggleLevel = (level: LogLevel) => {
    setLevels((prev) => {
      const next = new Set(prev);
      if (next.has(level)) next.delete(level);
      else next.add(level);
      return next;
    });
  };

  const toggleExpand = (id: string) => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="flex items-center gap-2 text-lg font-bold text-zinc-100">
            <ScrollText className="size-5 text-amber-500" />
            لاگ‌های سیستم
          </h1>
          <p className="mt-1 text-xs text-zinc-500">
            رویدادهای موتور، اتصالات و کپی — ۲۰۰ رکورد آخر
          </p>
        </div>
        <div className="flex items-center gap-4">
          <div className="flex items-center gap-2">
            <Switch id="logs-live" checked={live} onCheckedChange={setLive} />
            <Label htmlFor="logs-live" className="flex items-center gap-1.5 text-xs text-zinc-300">
              زنده
              <span
                className={cn(
                  "inline-block size-1.5 rounded-full",
                  live ? "animate-pulse bg-emerald-500" : "bg-zinc-600"
                )}
              />
            </Label>
          </div>
          <Button asChild variant="outline" className="h-11 gap-1.5 border-zinc-700 text-zinc-300 sm:h-9">
            <a href="/api/logs/export?format=csv" download>
              <Download className="size-4" />
              خروجی CSV
            </a>
          </Button>
        </div>
      </div>

      {/* filters */}
      <div className="flex flex-col gap-4 rounded-xl border border-zinc-800 bg-zinc-900/60 p-4">
        <div className="flex flex-wrap items-end gap-4">
          <div className="flex flex-col gap-1.5">
            <span className="text-xs text-zinc-500">سطح</span>
            <div className="flex flex-wrap gap-1.5">
              {ALL_LEVELS.map((level) => {
                const active = levels.has(level);
                const meta = LOG_LEVEL_META[level];
                return (
                  <button
                    key={level}
                    type="button"
                    onClick={() => toggleLevel(level)}
                    className={cn(
                      "inline-flex h-11 items-center gap-1.5 rounded-md border px-3 text-xs transition-colors sm:h-9",
                      active
                        ? meta.badge
                        : "border-zinc-800 bg-transparent text-zinc-600 hover:text-zinc-400"
                    )}
                    aria-pressed={active}
                  >
                    <span className={cn("inline-block size-2 rounded-full", active ? meta.dot : "bg-zinc-700")} />
                    {meta.label}
                  </button>
                );
              })}
            </div>
          </div>
          <div className="flex flex-col gap-1.5">
            <span className="text-xs text-zinc-500">دسته</span>
            <Select value={category} onValueChange={setCategory}>
              <SelectTrigger className="h-11! w-40 sm:h-9!" aria-label="فیلتر دسته">
                <SelectValue />
              </SelectTrigger>
              <SelectContent className="border-zinc-800 bg-zinc-900">
                <SelectItem value="all">همه دسته‌ها</SelectItem>
                {categories.map((cat) => (
                  <SelectItem key={cat} value={cat}>
                    <Mono className="text-xs">{cat}</Mono>
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="flex flex-col gap-1.5">
            <span className="text-xs text-zinc-500">ترمینال</span>
            <Select value={terminalId} onValueChange={setTerminalId}>
              <SelectTrigger className="h-11! w-44 sm:h-9!" aria-label="فیلتر ترمینال">
                <SelectValue />
              </SelectTrigger>
              <SelectContent className="border-zinc-800 bg-zinc-900">
                <SelectItem value="all">همه ترمینال‌ها</SelectItem>
                {(snapshot?.terminals ?? []).map((t) => (
                  <SelectItem key={t.id} value={t.id}>
                    {t.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="flex min-w-48 flex-1 flex-col gap-1.5">
            <Label htmlFor="logs-q" className="text-xs text-zinc-500">جستجو در پیام‌ها</Label>
            <Input
              id="logs-q"
              className="text-start"
              placeholder="مثلاً اسپرد یا تیکت"
              value={q}
              onChange={(e) => setQ(e.target.value)}
            />
          </div>
          <Button
            variant="outline"
            disabled={!hasFilter}
            onClick={resetFilters}
            className="h-11 gap-1.5 border-zinc-700 text-zinc-300 sm:h-9"
          >
            <Eraser className="size-4" />
            پاک‌سازی فیلترها
          </Button>
        </div>
      </div>

      {error && !logs ? (
        <ErrorBanner message={error} onRetry={refresh} />
      ) : loading && !logs ? (
        <div className="flex flex-col gap-2">
          {Array.from({ length: 8 }).map((_, i) => (
            <div key={i} className="h-9 animate-pulse rounded-lg bg-zinc-900/80" />
          ))}
        </div>
      ) : rows.length === 0 ? (
        <EmptyState
          icon={<ScrollText className="size-8" />}
          title={hasFilter ? "لاگی مطابق فیلترها یافت نشد" : "هنوز لاگی ثبت نشده است"}
          hint={
            hasFilter
              ? "سطوح یا دسته‌ها را گسترده‌تر انتخاب کنید."
              : "رویدادها به‌محض رخ دادن (اتصال، کپی، خطا) این‌جا نمایش داده می‌شوند."
          }
        />
      ) : (
        <div className="max-h-[65vh] overflow-auto rounded-xl border border-zinc-800 bg-zinc-900/60">
          <Table>
            <TableHeader className="sticky top-0 z-10 bg-zinc-900">
              <TableRow className="border-zinc-800 hover:bg-transparent">
                <TableHead className="w-8 px-3 text-zinc-400" aria-label="سطح" />
                <TableHead className="text-zinc-400">زمان</TableHead>
                <TableHead className="text-zinc-400">دسته</TableHead>
                <TableHead className="text-zinc-400">ترمینال</TableHead>
                <TableHead className="text-zinc-400">پیام</TableHead>
                <TableHead className="w-10 text-zinc-400" aria-label="جزئیات" />
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.map((log) => {
                const meta = LOG_LEVEL_META[log.level];
                const isOpen = expanded.has(log.id);
                return (
                  <Fragment key={log.id}>
                    <TableRow className={cn("align-top hover:bg-zinc-800/40", isOpen && "bg-zinc-800/30")}>
                      <TableCell className="px-3 pt-4">
                        <span className={cn("inline-block size-2 rounded-full", meta.dot)} />
                      </TableCell>
                      <TableCell className="whitespace-nowrap pt-4 text-xs text-zinc-400">
                        <FaDateTime ts={log.ts} />
                        <div className="mt-0.5 text-[10px] text-zinc-600">
                          <RelativeTime ts={log.ts} />
                        </div>
                      </TableCell>
                      <TableCell className="pt-4">
                        <Badge variant="outline" className={cn("text-[10px]", meta.badge)}>
                          <Mono className="text-[10px]">{log.category}</Mono>
                        </Badge>
                      </TableCell>
                      <TableCell className="whitespace-nowrap pt-4 text-xs text-zinc-300">
                        {log.terminalName || "—"}
                      </TableCell>
                      <TableCell className="max-w-md pt-4 text-sm leading-6 text-zinc-200">
                        {log.message}
                      </TableCell>
                      <TableCell className="pt-3">
                        {log.details ? (
                          <button
                            type="button"
                            onClick={() => toggleExpand(log.id)}
                            aria-label={isOpen ? "بستن جزئیات" : "نمایش جزئیات"}
                            aria-expanded={isOpen}
                            className="inline-flex size-9 items-center justify-center rounded-md text-zinc-500 transition-colors hover:bg-zinc-800 hover:text-zinc-300"
                          >
                            <ChevronDown className={cn("size-4 transition-transform", isOpen && "rotate-180")} />
                          </button>
                        ) : (
                          <span className="text-zinc-700">—</span>
                        )}
                      </TableCell>
                    </TableRow>
                    {isOpen && log.details ? (
                      <TableRow className="hover:bg-transparent">
                        <TableCell colSpan={6} className="px-4 pb-4">
                          <pre
                            dir="ltr"
                            className="max-h-44 overflow-auto rounded-lg border border-zinc-800 bg-zinc-950 p-3 text-left font-mono text-[11px] leading-5 text-zinc-400"
                          >
                            {prettyDetails(log.details)}
                          </pre>
                        </TableCell>
                      </TableRow>
                    ) : null}
                  </Fragment>
                );
              })}
            </TableBody>
          </Table>
        </div>
      )}
    </div>
  );
}
