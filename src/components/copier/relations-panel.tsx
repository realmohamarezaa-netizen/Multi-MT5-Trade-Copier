"use client";

import { cn } from "@/lib/utils";
import { Badge } from "@/components/ui/badge";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { Layers } from "lucide-react";

import type { CopyOperationDTO, MasterTradeRelationDTO } from "@/lib/types";
import {
  COPY_STATUS_META,
  EmptyState,
  MonoChip,
  SideBadge,
} from "./common";
import { Mono, Num, ProfitNum, RelativeTime, faCount } from "./format";

/* ------------------------------------------------------------------ */
/* per-slave copy chips                                                */
/* ------------------------------------------------------------------ */

export function CopyOpChips({ copies }: { copies: CopyOperationDTO[] }) {
  if (copies.length === 0) {
    return <span className="text-xs text-zinc-600">بدون کپی برای اسلیوها</span>;
  }
  return (
    <div className="flex flex-wrap items-center gap-1.5">
      {copies.map((copy) => {
        const meta = COPY_STATUS_META[copy.status];
        const showReason =
          (copy.status === "failed" || copy.status === "skipped") &&
          copy.failReason?.length > 0;
        const chip = (
          <span
            className={cn(
              "inline-flex max-w-[260px] items-center gap-1.5 rounded-md border px-2 py-1 text-xs",
              meta.badge
            )}
          >
            <span className={cn("inline-block size-1.5 shrink-0 rounded-full", meta.icon)} />
            <span className="truncate">{copy.slaveName}</span>
            <span className="opacity-80">· {meta.label}</span>
            {typeof copy.latencyMs === "number" && copy.latencyMs > 0 ? (
              <Mono className="text-[11px] opacity-90">{`${copy.latencyMs}ms`}</Mono>
            ) : null}
          </span>
        );
        if (!showReason) return <span key={copy.id}>{chip}</span>;
        return (
          <Tooltip key={copy.id}>
            <TooltipTrigger asChild>
              <span className="cursor-help">{chip}</span>
            </TooltipTrigger>
            <TooltipContent className="max-w-xs border-zinc-700 bg-zinc-900 text-zinc-200">
              <p className="font-medium">
                {copy.status === "failed" ? "دلیل شکست" : "دلیل رد شدن"}:
              </p>
              <p dir="ltr" className="mt-1 text-left font-mono text-[11px] text-zinc-400">
                {copy.failCode ? `${copy.failCode} — ` : ""}
                {copy.failReason}
              </p>
            </TooltipContent>
          </Tooltip>
        );
      })}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* relation card                                                       */
/* ------------------------------------------------------------------ */

function RelationRow({ relation }: { relation: MasterTradeRelationDTO }) {
  return (
    <div className="rounded-lg border border-zinc-800 bg-zinc-950/40 p-3 sm:p-4">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
        <span className="font-semibold text-zinc-100">{relation.symbol}</span>
        <SideBadge side={relation.side} />
        <Num value={relation.volume} digits={2} className="text-sm text-zinc-300" />
        <span className="text-xs text-zinc-500">
          ورود <Num value={relation.openPrice} digits={2} className="text-zinc-300" />
        </span>
        <MonoChip>{relation.masterTicket}</MonoChip>
        {relation.isOpen ? (
          <Badge variant="outline" className="border-emerald-500/30 bg-emerald-500/10 text-emerald-400">
            باز
          </Badge>
        ) : (
          <Badge variant="outline" className="border-zinc-700 text-zinc-400">
            بسته
          </Badge>
        )}
        <div className="ms-auto flex items-center gap-3 text-xs">
          {relation.profit !== 0 ? <ProfitNum value={relation.profit} className="text-sm" /> : null}
          <RelativeTime ts={relation.openTime} className="text-zinc-500" />
        </div>
      </div>
      {relation.sl ? (
        <p className="mt-2 text-[11px] text-zinc-500">
          SL <Num value={relation.sl} digits={2} className="text-zinc-400" />
          {relation.tp ? (
            <>
              {" · "}
              TP <Num value={relation.tp} digits={2} className="text-zinc-400" />
            </>
          ) : null}
        </p>
      ) : null}
      <div className="mt-3 border-t border-zinc-800/70 pt-3">
        <CopyOpChips copies={relation.copies} />
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* panel                                                               */
/* ------------------------------------------------------------------ */

export function RelationsPanel({
  relations,
  className,
}: {
  relations: MasterTradeRelationDTO[];
  className?: string;
}) {
  const open = relations.filter((r) => r.isOpen);
  const closed = relations.filter((r) => !r.isOpen).slice(0, 12);

  if (relations.length === 0) {
    return (
      <EmptyState
        icon={<Layers className="size-8" />}
        title="هنوز معامله‌ای از مستر ثبت نشده است"
        hint="به‌محض باز شدن معامله در ترمینال مستر، وضعیت کپی آن برای هر اسلیو در همین بخش نمایش داده می‌شود."
        className={className}
      />
    );
  }

  return (
    <div className={cn("flex flex-col gap-4", className)}>
      {open.length > 0 ? (
        <section className="flex flex-col gap-2">
          <h3 className="flex items-center gap-2 text-xs font-medium text-zinc-400">
            معاملات باز مستر
            <Badge variant="outline" className="border-zinc-800 text-zinc-500">
              {faCount(open.length)}
            </Badge>
          </h3>
          {open.map((relation) => (
            <RelationRow key={relation.masterTicket} relation={relation} />
          ))}
        </section>
      ) : null}

      {closed.length > 0 ? (
        <section className="flex flex-col gap-2">
          <h3 className="flex items-center gap-2 text-xs font-medium text-zinc-400">
            بسته‌شده‌های اخیر
            <Badge variant="outline" className="border-zinc-800 text-zinc-500">
              {faCount(closed.length)}
            </Badge>
          </h3>
          {closed.map((relation) => (
            <RelationRow key={relation.masterTicket} relation={relation} />
          ))}
        </section>
      ) : null}
    </div>
  );
}
