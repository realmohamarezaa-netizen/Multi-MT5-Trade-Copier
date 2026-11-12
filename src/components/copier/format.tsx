"use client";

import { useEffect, useState } from "react";

import { cn } from "@/lib/utils";

/* ------------------------------------------------------------------ */
/* number / datetime helpers                                           */
/* ------------------------------------------------------------------ */

/** Latin-digit number for prices/lots/profits (rendered inside font-mono). */
export function fmtLatin(
  value: number | null | undefined,
  digits = 2
): string {
  if (value === null || value === undefined || Number.isNaN(value)) return "—";
  return value.toLocaleString("en-US", {
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  });
}

/** Persian-digit count (Intl fa-IR) for natural counts. */
export function faCount(value: number | null | undefined): string {
  if (value === null || value === undefined || Number.isNaN(value)) return "۰";
  return new Intl.NumberFormat("fa-IR").format(value);
}

export function faDateTime(ts: number | null | undefined): string {
  if (!ts) return "—";
  return new Date(ts).toLocaleString("fa-IR", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
}

export function faDate(ts: number | null | undefined): string {
  if (!ts) return "—";
  return new Date(ts).toLocaleDateString("fa-IR", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  });
}

/** Persian relative time like «۵ ثانیه پیش». */
export function relFa(ts: number | null | undefined): string {
  if (!ts) return "—";
  const diff = Math.round((ts - Date.now()) / 1000);
  const abs = Math.abs(diff);
  const rtf = new Intl.RelativeTimeFormat("fa", { numeric: "auto" });
  if (abs < 60) return rtf.format(diff, "second");
  if (abs < 3600) return rtf.format(Math.round(diff / 60), "minute");
  if (abs < 86400) return rtf.format(Math.round(diff / 3600), "hour");
  return rtf.format(Math.round(diff / 86400), "day");
}

/* ------------------------------------------------------------------ */
/* hydration-safe display components                                   */
/* ------------------------------------------------------------------ */

/** LTR monospace span so tickets/prices render correctly inside RTL text. */
export function Mono({
  children,
  className,
}: {
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <span dir="ltr" className={cn("font-mono tnum", className)}>
      {children}
    </span>
  );
}

export function Num({
  value,
  digits = 2,
  className,
}: {
  value: number | null | undefined;
  digits?: number;
  className?: string;
}) {
  return <Mono className={className}>{fmtLatin(value, digits)}</Mono>;
}

/** Signed + colored floating P/L / profit. */
export function ProfitNum({
  value,
  digits = 2,
  className,
}: {
  value: number | null | undefined;
  digits?: number;
  className?: string;
}) {
  const v = typeof value === "number" && !Number.isNaN(value) ? value : null;
  const color =
    v === null
      ? "text-zinc-500"
      : v > 0
        ? "text-emerald-500"
        : v < 0
          ? "text-red-500"
          : "text-zinc-400";
  const text =
    v === null
      ? "—"
      : `${v > 0 ? "+" : ""}${fmtLatin(v, digits)}`;
  return <Mono className={cn(color, className)}>{text}</Mono>;
}

/** Mount-safe fa-IR datetime (renders placeholder during SSR). */
export function FaDateTime({
  ts,
  className,
}: {
  ts: number | null | undefined;
  className?: string;
}) {
  const [text, setText] = useState<string>("—");
  useEffect(() => {
    const update = () => setText(faDateTime(ts));
    const first = setTimeout(update, 0);
    return () => clearTimeout(first);
  }, [ts]);
  return (
    <span className={className} suppressHydrationWarning>
      {text}
    </span>
  );
}

export function FaDate({
  ts,
  className,
}: {
  ts: number | null | undefined;
  className?: string;
}) {
  const [text, setText] = useState<string>("—");
  useEffect(() => {
    const update = () => setText(faDate(ts));
    const first = setTimeout(update, 0);
    return () => clearTimeout(first);
  }, [ts]);
  return (
    <span className={className} suppressHydrationWarning>
      {text}
    </span>
  );
}

/** Mount-safe relative time, refreshed every 2s while visible. */
export function RelativeTime({
  ts,
  className,
}: {
  ts: number | null | undefined;
  className?: string;
}) {
  const [text, setText] = useState<string>("—");
  useEffect(() => {
    if (!ts) return;
    const update = () => setText(relFa(ts));
    const first = setTimeout(update, 0);
    const id = setInterval(update, 2000);
    return () => {
      clearTimeout(first);
      clearInterval(id);
    };
  }, [ts]);
  return (
    <span className={className} suppressHydrationWarning>
      {text}
    </span>
  );
}

/** Client-only live clock (HH:MM:SS, latin digits, monospace). */
export function LiveClock({ className }: { className?: string }) {
  const [now, setNow] = useState<Date | null>(null);
  useEffect(() => {
    const update = () => setNow(new Date());
    const first = setTimeout(update, 0);
    const id = setInterval(update, 1000);
    return () => {
      clearTimeout(first);
      clearInterval(id);
    };
  }, []);
  const text = now
    ? now.toLocaleTimeString("en-GB", { hour12: false })
    : "--:--:--";
  return (
    <Mono className={cn("text-zinc-400", className)}>{text}</Mono>
  );
}
