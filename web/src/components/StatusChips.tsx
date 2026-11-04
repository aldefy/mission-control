import type { Overview, Status } from "@/lib/api"
import type { ChipFilter } from "@/lib/tree"
import { cn } from "@/lib/utils"
import { StatusDot } from "@/components/StatusDot"

/** `dot`: a status dot; `mark`: a plain coloured dot for chips that are not a status (Ready). */
type Chip = { filter: ChipFilter; label: string; dot?: Status; mark?: string; tone: string; ring: string }

const CHIPS: Chip[] = [
  { filter: "waiting", label: "Needs you", dot: "waiting", tone: "bg-needs-you/10 text-needs-you", ring: "ring-needs-you/70" },
  { filter: "looping", label: "Looping", dot: "looping", tone: "bg-looping/10 text-looping", ring: "ring-looping/70" },
  // Calm info tone: ready is findable, never urgent (amber stays for Needs you only).
  { filter: "ready", label: "Ready", mark: "bg-consult", tone: "bg-consult/10 text-consult", ring: "ring-consult/70" },
  { filter: "working", label: "Working", dot: "working", tone: "bg-running/10 text-running", ring: "ring-running/70" },
  { filter: "stopped", label: "Stopped", dot: "stopped", tone: "bg-secondary text-secondary-foreground/80", ring: "ring-stopped/70" },
  { filter: "done", label: "Done today", dot: "done", tone: "bg-secondary text-muted-foreground", ring: "ring-muted-foreground/60" },
  { filter: "closed", label: "Closed", dot: "idle", tone: "bg-secondary text-muted-foreground", ring: "ring-muted-foreground/60" },
]

/** The counts each chip shows: overview counts, plus done-today from the project tree. */
export function chipCounts(o: Overview | null, doneToday: number): Record<ChipFilter, number | null> {
  return {
    waiting: o?.counts.waiting ?? null, looping: o ? (o.counts.looping ?? 0) : null, ready: o ? (o.counts.ready ?? 0) : null,
    working: o?.counts.working ?? null, stopped: o?.counts.stopped ?? null, done: doneToday, closed: o ? (o.counts.closed ?? 0) : null,
  }
}

/** Top-bar status chips (directions.html B). Clicking one filters the sidebar and views; clicking it again clears. */
export function StatusChips({
  counts,
  active,
  onPick,
}: {
  counts: Record<ChipFilter, number | null>
  active: ChipFilter | null
  onPick: (f: ChipFilter | null) => void
}) {
  return (
    <div className="no-scrollbar flex min-w-0 items-center gap-1.5 overflow-x-auto py-1" role="group" aria-label="Filter by status">
      {CHIPS.map((c) => {
        const n = counts[c.filter]
        const on = active === c.filter
        return (
          <button
            key={c.filter}
            type="button"
            aria-pressed={on}
            onClick={() => onPick(on ? null : c.filter)}
            title={c.label}
            className={cn(
              "flex shrink-0 items-center gap-1.5 h-7 rounded-full px-2.5 text-xs whitespace-nowrap transition-[box-shadow,opacity] hover:brightness-125",
              c.tone,
              on && `ring-1 ${c.ring}`,
              active && !on && "opacity-50",
              n === 0 && !on && "opacity-60",
            )}
          >
            {c.dot ? (
              <StatusDot status={c.dot} labelled live={c.filter === "working" && !!n} className={c.filter === "waiting" && !n ? "shadow-none" : undefined} />
            ) : (
              <i aria-hidden data-chip-mark={c.filter} className={cn("mc-dot inline-block size-2 shrink-0 rounded-full not-italic", c.mark)} />
            )}
            <span className="max-xl:sr-only">{c.label}</span>
            <span className="font-mono tabular-nums">{n ?? "–"}</span>
          </button>
        )
      })}
    </div>
  )
}
