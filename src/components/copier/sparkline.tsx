"use client";

import { cn } from "@/lib/utils";

export interface SparkPoint {
  totalMs: number;
  ok: boolean;
}

/**
 * Tiny hand-rolled SVG sparkline for recent copy latencies.
 * Emerald dots = successful ops, red dots = failed ops.
 */
export function Sparkline({
  data,
  height = 56,
  className,
}: {
  data: SparkPoint[];
  height?: number;
  className?: string;
}) {
  const points = data.slice(-60);
  if (points.length === 0) {
    return (
      <div
        className={cn(
          "flex items-center justify-center text-xs text-zinc-600",
          className
        )}
        style={{ height }}
      >
        هنوز داده‌ای برای نمودار تأخیر ثبت نشده است
      </div>
    );
  }

  const width = 320;
  const padX = 6;
  const padY = 8;
  const max = Math.max(...points.map((p) => p.totalMs), 1);
  const step = points.length === 1 ? 0 : (width - padX * 2) / (points.length - 1);
  const coords = points.map((p, i) => ({
    x: padX + i * step,
    y: height - padY - (p.totalMs / max) * (height - padY * 2),
    ok: p.ok,
  }));
  const path = coords
    .map((c, i) => `${i === 0 ? "M" : "L"}${c.x.toFixed(1)},${c.y.toFixed(1)}`)
    .join(" ");

  return (
    <svg
      viewBox={`0 0 ${width} ${height}`}
      preserveAspectRatio="none"
      className={cn("w-full", className)}
      style={{ height }}
      role="img"
      aria-label="نمودار تأخیر اخیر"
    >
      <path
        d={path}
        fill="none"
        stroke="#52525b"
        strokeWidth="1.5"
        strokeLinejoin="round"
        strokeLinecap="round"
      />
      {coords.map((c, i) => (
        <circle
          key={i}
          cx={c.x}
          cy={c.y}
          r="2.5"
          fill={c.ok ? "#10b981" : "#ef4444"}
        />
      ))}
    </svg>
  );
}

/** Compact legend used next to the sparkline. */
export function SparklineLegend({ className }: { className?: string }) {
  return (
    <div className={cn("flex items-center gap-4 text-[11px] text-zinc-500", className)}>
      <span className="flex items-center gap-1.5">
        <span className="inline-block size-2 rounded-full bg-emerald-500" />
        عملیات موفق
      </span>
      <span className="flex items-center gap-1.5">
        <span className="inline-block size-2 rounded-full bg-red-500" />
        عملیات ناموفق
      </span>
    </div>
  );
}
