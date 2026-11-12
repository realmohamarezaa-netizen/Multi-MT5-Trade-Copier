"use client";

import type { ReactNode } from "react";

import { cn } from "@/lib/utils";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { AlertTriangle, RefreshCw } from "lucide-react";

import type {
  CopyAction,
  CopyOpStatus,
  TerminalRole,
  TerminalStatus,
} from "@/lib/types";
import { Mono, faCount, fmtLatin } from "./format";

/* ------------------------------------------------------------------ */
/* meta maps                                                           */
/* ------------------------------------------------------------------ */

export const TERMINAL_STATUS_META: Record<
  TerminalStatus,
  { label: string; dot: string; badge: string; hint: string }
> = {
  connected: {
    label: "متصل",
    dot: "bg-emerald-500",
    badge: "border-emerald-500/30 bg-emerald-500/10 text-emerald-400",
    hint: "ترمینال در دسترس و پاسخ‌گو است",
  },
  connecting: {
    label: "در حال اتصال",
    dot: "bg-amber-500 animate-pulse",
    badge: "border-amber-500/30 bg-amber-500/10 text-amber-400",
    hint: "اتصال اولیه در جریان است",
  },
  reconnecting: {
    label: "اتصال مجدد",
    dot: "bg-amber-500 animate-pulse",
    badge: "border-amber-500/30 bg-amber-500/10 text-amber-400",
    hint: "قطع‌شدگی موقت؛ تلاش خودکار برای اتصال مجدد",
  },
  disconnected: {
    label: "قطع",
    dot: "bg-zinc-500",
    badge: "border-zinc-700 bg-zinc-800/60 text-zinc-400",
    hint: "بدون ارتباط با ترمینال",
  },
  error: {
    label: "خطا",
    dot: "bg-red-500",
    badge: "border-red-500/30 bg-red-500/10 text-red-400",
    hint: "پاسخ نامعتبر یا خطای اکسپرت",
  },
};

export const ROLE_LABELS: Record<TerminalRole, string> = {
  master: "مستر",
  slave: "اسلیو",
  none: "بدون نقش",
};

export const COPY_STATUS_META: Record<
  CopyOpStatus,
  { label: string; badge: string; icon: string }
> = {
  pending: { label: "در صف", badge: "border-zinc-700 bg-zinc-800/60 text-zinc-300", icon: "bg-zinc-400" },
  sent: { label: "ارسال شد", badge: "border-amber-500/30 bg-amber-500/10 text-amber-400", icon: "bg-amber-500" },
  executed: { label: "اجرا شد", badge: "border-emerald-500/30 bg-emerald-500/10 text-emerald-400", icon: "bg-emerald-500" },
  failed: { label: "ناموفق", badge: "border-red-500/30 bg-red-500/10 text-red-400", icon: "bg-red-500" },
  skipped: { label: "رد شد", badge: "border-amber-500/30 bg-amber-500/10 text-amber-400", icon: "bg-amber-500" },
  missed: { label: "جا افتاد", badge: "border-zinc-700 bg-zinc-800/60 text-zinc-400", icon: "bg-zinc-500" },
};

export const ACTION_LABELS: Record<CopyAction, string> = {
  open: "باز کردن",
  close: "بستن",
  partial: "بستن جزئی",
  modify_sltp: "تغییر SL/TP",
  place_pending: "ثبت سفارش",
  cancel_pending: "لغو سفارش",
};

export const CLOSE_REASON_LABELS: Record<string, string> = {
  manual: "دستی",
  sl: "استاپ‌لاس",
  tp: "تیک‌پرافیت",
  engine: "موتور",
};

export function closeReasonLabel(reason: string): string {
  return CLOSE_REASON_LABELS[reason] ?? "سایر";
}

export function closeReasonBadgeClass(reason: string): string {
  switch (reason) {
    case "tp":
      return "border-emerald-500/30 bg-emerald-500/10 text-emerald-400";
    case "sl":
      return "border-red-500/30 bg-red-500/10 text-red-400";
    case "engine":
      return "border-amber-500/30 bg-amber-500/10 text-amber-400";
    case "manual":
      return "border-zinc-700 bg-zinc-800/60 text-zinc-300";
    default:
      return "border-zinc-700 bg-zinc-800/60 text-zinc-400";
  }
}

export const LOG_LEVEL_META: Record<
  "info" | "success" | "warn" | "error",
  { label: string; dot: string; badge: string }
> = {
  info: { label: "اطلاع", dot: "bg-zinc-400", badge: "border-zinc-700 bg-zinc-800/60 text-zinc-300" },
  success: { label: "موفق", dot: "bg-emerald-500", badge: "border-emerald-500/30 bg-emerald-500/10 text-emerald-400" },
  warn: { label: "هشدار", dot: "bg-amber-500", badge: "border-amber-500/30 bg-amber-500/10 text-amber-400" },
  error: { label: "خطا", dot: "bg-red-500", badge: "border-red-500/30 bg-red-500/10 text-red-400" },
};

/* ------------------------------------------------------------------ */
/* badge components                                                    */
/* ------------------------------------------------------------------ */

export function StatusDot({ className }: { className?: string }) {
  return <span className={cn("inline-block size-2 shrink-0 rounded-full", className)} />;
}

export function StatusBadge({
  status,
  className,
}: {
  status: TerminalStatus;
  className?: string;
}) {
  const meta = TERMINAL_STATUS_META[status];
  return (
    <Badge
      variant="outline"
      className={cn("gap-1.5 px-2 py-1", meta.badge, className)}
    >
      <StatusDot className={meta.dot} />
      {meta.label}
    </Badge>
  );
}

export function RoleBadge({ role, className }: { role: TerminalRole; className?: string }) {
  if (role === "master") {
    return (
      <Badge
        variant="outline"
        className={cn("border-amber-500/40 bg-amber-500/10 text-amber-400", className)}
      >
        مستر
      </Badge>
    );
  }
  if (role === "slave") {
    return (
      <Badge variant="outline" className={cn("border-zinc-700 bg-zinc-800/60 text-zinc-300", className)}>
        اسلیو
      </Badge>
    );
  }
  return (
    <Badge variant="outline" className={cn("border-zinc-800 text-zinc-500", className)}>
      بدون نقش
    </Badge>
  );
}

export function SideBadge({ side, className }: { side: "buy" | "sell"; className?: string }) {
  return side === "buy" ? (
    <Badge variant="outline" className={cn("border-emerald-500/30 bg-emerald-500/10 text-emerald-400", className)}>
      خرید
    </Badge>
  ) : (
    <Badge variant="outline" className={cn("border-red-500/30 bg-red-500/10 text-red-400", className)}>
      فروش
    </Badge>
  );
}

export function CopyStatusBadge({
  status,
  className,
}: {
  status: CopyOpStatus;
  className?: string;
}) {
  const meta = COPY_STATUS_META[status];
  return (
    <Badge variant="outline" className={cn(meta.badge, className)}>
      {meta.label}
    </Badge>
  );
}

/* ------------------------------------------------------------------ */
/* layout primitives                                                   */
/* ------------------------------------------------------------------ */

export function StatCard({
  title,
  children,
  hint,
  className,
}: {
  title: string;
  children: ReactNode;
  hint?: ReactNode;
  className?: string;
}) {
  return (
    <div
      className={cn(
        "rounded-xl border border-zinc-800 bg-zinc-900/60 p-4 flex flex-col gap-1.5 min-w-0",
        className
      )}
    >
      <span className="text-xs text-zinc-500 truncate">{title}</span>
      <div className="text-lg sm:text-xl font-semibold leading-tight flex items-baseline gap-1.5 min-w-0">
        {children}
      </div>
      {hint ? <div className="text-[11px] text-zinc-500 truncate">{hint}</div> : null}
    </div>
  );
}

export function ErrorBanner({
  message,
  onRetry,
  className,
}: {
  message: string;
  onRetry?: () => void;
  className?: string;
}) {
  return (
    <div
      className={cn(
        "flex flex-col sm:flex-row sm:items-center gap-3 rounded-xl border border-red-500/30 bg-red-500/10 px-4 py-3 text-sm text-red-300",
        className
      )}
      role="alert"
    >
      <AlertTriangle className="size-5 shrink-0" />
      <div className="flex-1 min-w-0">
        <p className="font-medium">دریافت داده ناموفق بود</p>
        <p className="mt-0.5 text-red-400/80 break-words">{message}</p>
      </div>
      {onRetry ? (
        <Button variant="outline" size="sm" onClick={onRetry} className="shrink-0 border-red-500/40 text-red-300 hover:bg-red-500/10 h-11 sm:h-9">
          <RefreshCw className="size-4" />
          تلاش مجدد
        </Button>
      ) : null}
    </div>
  );
}

export function EmptyState({
  title,
  hint,
  icon,
  action,
  className,
}: {
  title: string;
  hint?: string;
  icon?: ReactNode;
  action?: ReactNode;
  className?: string;
}) {
  return (
    <div
      className={cn(
        "flex flex-col items-center justify-center gap-3 rounded-xl border border-dashed border-zinc-800 bg-zinc-900/40 px-6 py-12 text-center",
        className
      )}
    >
      {icon ? <div className="text-zinc-600">{icon}</div> : null}
      <p className="text-sm font-medium text-zinc-300">{title}</p>
      {hint ? <p className="max-w-md text-xs leading-5 text-zinc-500">{hint}</p> : null}
      {action ? <div className="mt-1">{action}</div> : null}
    </div>
  );
}

export function SkeletonRows({ rows = 5, className }: { rows?: number; className?: string }) {
  return (
    <div className={cn("flex flex-col gap-2", className)}>
      {Array.from({ length: rows }).map((_, i) => (
        <Skeleton key={i} className="h-10 w-full rounded-lg bg-zinc-800/60" />
      ))}
    </div>
  );
}

export function SkeletonCards({ count = 6, className }: { count?: number; className?: string }) {
  return (
    <div
      className={cn(
        "grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-3",
        className
      )}
    >
      {Array.from({ length: count }).map((_, i) => (
        <div key={i} className="rounded-xl border border-zinc-800 bg-zinc-900/60 p-4">
          <div className="flex items-center justify-between gap-2">
            <Skeleton className="h-5 w-28 bg-zinc-800/60" />
            <Skeleton className="h-5 w-16 bg-zinc-800/60" />
          </div>
          <div className="mt-4 flex flex-col gap-2.5">
            {Array.from({ length: 5 }).map((_, j) => (
              <Skeleton key={j} className="h-4 w-full bg-zinc-800/40" />
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}

export function PageSkeleton({ cards = 6 }: { cards?: number }) {
  return (
    <div className="flex flex-col gap-6">
      <div className="grid grid-cols-2 gap-4 md:grid-cols-3 xl:grid-cols-5">
        {Array.from({ length: 5 }).map((_, i) => (
          <Skeleton key={i} className="h-20 rounded-xl bg-zinc-900/60" />
        ))}
      </div>
      <SkeletonCards count={cards} />
    </div>
  );
}

/** RTL-friendly progress bar (fills from the right). */
export function RtlProgress({
  value,
  className,
  barClassName,
}: {
  value: number;
  className?: string;
  barClassName?: string;
}) {
  const pct = Math.max(0, Math.min(100, value));
  return (
    <div className={cn("h-2 w-full overflow-hidden rounded-full bg-zinc-800", className)}>
      <div
        className={cn("h-full rounded-full bg-amber-500 transition-all", barClassName)}
        style={{ width: `${pct}%`, marginLeft: "auto" }}
      />
    </div>
  );
}

export function SectionCard({
  title,
  description,
  action,
  children,
  className,
  contentClassName,
}: {
  title?: ReactNode;
  description?: string;
  action?: ReactNode;
  children: ReactNode;
  className?: string;
  contentClassName?: string;
}) {
  return (
    <div className={cn("rounded-xl border border-zinc-800 bg-zinc-900/60", className)}>
      {title || action ? (
        <div className="flex flex-wrap items-center justify-between gap-3 border-b border-zinc-800 px-4 py-3 sm:px-6">
          <div className="min-w-0">
            {title ? <h2 className="text-sm font-semibold text-zinc-200">{title}</h2> : null}
            {description ? <p className="mt-0.5 text-xs text-zinc-500">{description}</p> : null}
          </div>
          {action ? <div className="flex shrink-0 items-center gap-2">{action}</div> : null}
        </div>
      ) : null}
      <div className={cn("p-4 sm:p-6", contentClassName)}>{children}</div>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* shared small pieces                                                 */
/* ------------------------------------------------------------------ */

export function MonoChip({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <span
      className={cn(
        "inline-flex items-center rounded-md border border-zinc-800 bg-zinc-950/60 px-1.5 py-0.5 text-[11px] text-zinc-300",
        className
      )}
    >
      <Mono>{children}</Mono>
    </span>
  );
}

export function CountText({ value, className }: { value: number; className?: string }) {
  return <span className={className}>{faCount(value)}</span>;
}

export function LatencyText({ ms, className }: { ms: number | null | undefined; className?: string }) {
  if (ms === null || ms === undefined || Number.isNaN(ms)) return <span className="text-zinc-600">—</span>;
  return <Mono className={className}>{`${fmtLatin(ms, 0)}ms`}</Mono>;
}
