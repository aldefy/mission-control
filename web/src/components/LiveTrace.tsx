import { useEffect, useRef } from "react"
import type { Call } from "@/lib/api"
import { cn } from "@/lib/utils"

const MAX_ROWS = 80

const time = (ts: string) => {
  const d = new Date(ts)
  return Number.isNaN(d.getTime()) ? "" : d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" })
}
const dur = (ms?: number) => (ms == null ? "" : ms < 1000 ? `${ms}ms` : `${(ms / 1000).toFixed(ms < 10_000 ? 1 : 0)}s`)

/**
 * The trace beside the chat: every tool call as it happens, oldest at the top, grouped into runs of the same
 * lane (main or a sub-agent), with what it did, how long it took and whether it failed. It follows the newest
 * call while live, unless you scrolled up. New calls arrive pushed (the item's fetch refetches on the server's
 * "changed" event), not on a timer.
 */
export function LiveTrace({ calls, live, laneLabel, onOpen, className }: { calls: Call[]; live: boolean; laneLabel: (lane: string) => string; onOpen: (id: string) => void; className?: string }) {
  const ref = useRef<HTMLDivElement>(null)
  const pinned = useRef(true)
  const rows = calls.slice(-MAX_ROWS)
  const last = rows.at(-1)?.id

  useEffect(() => {
    const el = ref.current
    if (el && pinned.current) el.scrollTop = el.scrollHeight
  }, [last])

  const failed = calls.filter((c) => c.ok === false).length
  return (
    <aside data-live-trace aria-label="Trace" className={cn("flex min-h-0 flex-col rounded-xl border bg-card/30", className)}>
      <header className="flex items-baseline justify-between gap-2 border-b px-3 py-2">
        <h3 className="text-sm font-medium">Trace{live && <span className="mc-live ml-2 font-mono text-xs text-faint">live</span>}</h3>
        <span className="font-mono text-xs text-faint">
          {calls.length} calls{failed ? <span className="text-destructive"> · {failed} failed</span> : null}
          {calls.length > MAX_ROWS ? ` · last ${MAX_ROWS}` : ""}
        </span>
      </header>
      <div ref={ref} className="min-h-0 flex-1 overflow-y-auto px-1 py-1"
        onScroll={(e) => { const el = e.currentTarget; pinned.current = el.scrollHeight - el.scrollTop - el.clientHeight < 24 }}>
        {rows.length === 0 && <p className="px-2 py-6 text-center text-xs text-faint">No tool calls yet.</p>}
        <ol className="flex flex-col">
          {rows.map((c, i) => {
            const newLane = i === 0 || rows[i - 1].lane !== c.lane
            return (
              <li key={c.id}>
                {newLane && <div className="mt-1 px-2 pt-1 font-mono text-[11px] uppercase tracking-wide text-faint">{laneLabel(c.lane)}</div>}
                <button type="button" onClick={() => onOpen(c.id)} title={c.error ?? c.summary}
                  className={cn("grid w-full grid-cols-[4.5rem_1fr_auto] items-baseline gap-2 rounded px-2 py-0.5 text-left text-xs hover:bg-muted/60", c.ok === false && "text-destructive")}>
                  <span className="font-mono text-faint">{time(c.ts)}</span>
                  <span className="truncate">
                    <span className="font-medium">{c.name}</span> <span className={c.ok === false ? "" : "text-muted-foreground"}>{c.summary}</span>
                  </span>
                  <span className="font-mono text-faint">{c.ok === false ? "failed" : c.ok === undefined && live && c.id === last ? "running" : dur(c.durationMs)}</span>
                </button>
              </li>
            )
          })}
        </ol>
      </div>
    </aside>
  )
}
