import { useEffect, useRef, useState } from "react"
import type { Call, ItemDetail } from "@/lib/api"
import { findings, health, openStopOf } from "@/lib/item"
import { Findings } from "@/components/Findings"
import { HealthCard } from "@/components/HealthCard"
import { NeedsYouCard, type Ask } from "@/components/NeedsYouCard"
import { cn } from "@/lib/utils"

/** What the needs-you card shows: a run's open stop, else a lane that waits on you (a hook-reported session). */
export function askOf(d: ItemDetail): Ask | null {
  const stop = openStopOf(d)
  if (stop) return { waiting: stop.waiting, lane: stop.stage, rule: stop.rule, detail: stop.detail, ts: stop.ts, sign: stop.sign === true }
  const w = d.lanes.find((l) => l.status === "waiting")
  if (w || d.summary.waiting) return { waiting: true, lane: w?.label, detail: w?.reason, ts: w?.ask?.since ?? d.summary.updatedAt ?? undefined, tool: w?.ask?.tool, target: w?.ask?.target, agent: w?.ask?.agent === true }
  return null
}

const FLASH_MS = 1600

/**
 * The item's right rail: needs-you (or stopped), health, findings. Each new `flash` value (a counter from
 * the map's "you" node) scrolls the needs-you card into view and flashes it, or the rail itself when no
 * card is shown. The flash is state, so a re-render never drops or replays it.
 */
export function RightRail({ detail, calls, actions, now, onActed, onOpen, flash = 0, part = "all" }: { detail: ItemDetail; calls: Call[] | null; actions: string[]; now: number; onActed?: () => void; onOpen?: (lane: string) => void; flash?: number; /** "ask": only the needs-you card (narrow pages put it above the tabs); "rest": the rest. */ part?: "all" | "ask" | "rest" }) {
  const ask = askOf(detail)
  const rail = useRef<HTMLElement>(null)
  const [lit, setLit] = useState(false)
  // The flash counter as of mount: a remount (back from another tab) never replays an old click.
  const seen = useRef(flash)
  useEffect(() => {
    if (!flash || flash === seen.current) return
    seen.current = flash
    const target = rail.current?.querySelector<HTMLElement>("[data-needs-you]") ?? rail.current
    target?.scrollIntoView?.({ behavior: matchMedia?.("(prefers-reduced-motion: reduce)")?.matches ? "auto" : "smooth", block: "center" })
    target?.focus?.({ preventScroll: true })
    setLit(false) // off for one frame so a second click restarts the animation
    const on = requestAnimationFrame(() => setLit(true))
    const off = setTimeout(() => setLit(false), FLASH_MS)
    return () => { cancelAnimationFrame(on); clearTimeout(off) }
  }, [flash])
  if (part === "ask" && !ask) return null
  return (
    <aside ref={rail} tabIndex={-1} data-lit={lit || undefined} className={cn("flex flex-col gap-4 rounded-xl outline-none", lit && !ask && "mc-flash")} aria-label="Item rail">
      {ask && part !== "rest" && <NeedsYouCard key={`${ask.lane}|${ask.ts}`} source={detail.summary.source} id={detail.summary.id} ask={ask} actions={actions} now={now} onActed={onActed} flash={lit} />}
      {part !== "ask" && <HealthCard h={health(detail, calls)} live={detail.summary.live} />}
      {part !== "ask" && <Findings items={findings(detail, calls ?? [])} onOpen={onOpen} />}
    </aside>
  )
}
