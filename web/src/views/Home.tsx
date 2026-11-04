import { workingLine } from "@/lib/status-ui"
import { Retry } from "@/components/Retry"
import { useEffect, useMemo, useState } from "react"
import { Button } from "@/components/ui/button"
import { Panel } from "@/components/Panel"
import { ItemTable } from "@/components/ItemTable"
import { LiveActivity } from "@/components/LiveActivity"
import { NeedsYouQueue } from "@/components/NeedsYouQueue"
import { ReadyList } from "@/components/ReadyList"
import { LoopingList } from "@/components/LoopingList"
import { useItems, useSources, type ItemSummary } from "@/lib/api"
import { useNow } from "@/lib/format"
import { useShared } from "@/lib/projects-context"
import { toHash } from "@/lib/route"
import { matchesFilter } from "@/lib/tree"

const RECENT = 100

type Show = "open" | "closed" | "all" | "archived"
const SHOWS: Show[] = ["open", "closed", "all", "archived"]
const SHOW_LABEL: Record<Show, string> = { open: "open only", closed: "closed", all: "all", archived: "archived" }
const SHOW: Record<Exclude<Show, "archived">, (i: ItemSummary) => boolean> = {
  open: (i) => i.open !== false,
  closed: (i) => i.open === false,
  all: () => true,
}
const DAY_MS = 24 * 3600 * 1000

/** Items that stopped or failed in the last day, newest first (the queue's Stopped list). */
export function recentlyStopped(items: ItemSummary[], now: number, max = 4): ItemSummary[] {
  return items
    .filter((i) => (i.status === "stopped" || i.status === "failed") && i.updatedAt && now - Date.parse(i.updatedAt) < DAY_MS)
    .slice(0, max)
}

export default function Home() {
  const { overview, filter, showHidden, resets } = useShared()
  const sources = useSources()
  const [show, setShow] = useState<Show>("all")
  useEffect(() => setShow("all"), [resets]) // the logo resets the view
  const recent = useItems({ all: showHidden, archived: show === "archived", limit: RECENT })
  const now = useNow()
  const actions = useMemo(() => Object.fromEntries((sources.data ?? []).map((s) => [s.name, s.actions])), [sources.data])
  const items = recent.data ?? []
  const knowsOpen = items.some((i) => i.open !== undefined)
  const shown = useMemo(
    // A status chip picks its own items (the Closed chip lists closed ones whatever Show says); archived always applies.
    () => items.filter((i) => matchesFilter(i, filter) && (show === "archived" ? !!i.archived : filter || SHOW[show](i))),
    [items, filter, show],
  )
  const live = overview.data?.live ?? []

  return (
    <div className="-m-5 grid min-h-[calc(100%+2.5rem)] lg:grid-cols-[300px_minmax(0,1fr)]">
      <aside className="border-b p-4 lg:border-r lg:border-b-0" aria-label="Needs you">
        {overview.error && !overview.data ? (
          <div className="flex flex-wrap items-center gap-2 text-xs text-failed"><span>Could not load what needs you: {overview.error}</span><Retry onRetry={overview.reload} /></div>
        ) : (
          <NeedsYouQueue
            entries={overview.data?.needsYou ?? []}
            stopped={recentlyStopped(items, now)}
            actions={actions}
            onActed={overview.reload}
            now={now}
            loaded={!!overview.data}
            between={
              <>
                <LoopingList entries={overview.data?.looping ?? []} now={now} />
                <ReadyList entries={overview.data?.ready ?? []} now={now} />
              </>
            }
          />
        )}
      </aside>
      <div className="flex min-w-0 flex-col gap-5 p-5">
        <h1 className="sr-only">Home</h1>
        <Panel
          bodyClassName="p-2"
          title="Live now"
          aside={live.length > 0 && <span className="font-mono text-xs text-running">{workingLine(live)}</span>}
        >
          <LiveActivity lanes={live} now={now} />
        </Panel>
        <Panel
          bodyClassName="p-2"
          title="Recent"
          aside={
            <span className="flex flex-wrap items-center justify-end gap-x-3 gap-y-1 font-mono text-xs text-faint">
              <span>{shown.length} of {items.length}</span>
              <span className="flex items-center gap-0.5" role="group" aria-label="Show">
                <span className="mr-1">Show:</span>
                {(knowsOpen ? SHOWS : SHOWS.filter((v) => v === "all" || v === "archived")).map((v) => (
                  <Button key={v} variant={show === v ? "secondary" : "ghost"} size="xs" aria-pressed={show === v} onClick={() => setShow(v)}>
                    {SHOW_LABEL[v]}
                  </Button>
                ))}
              </span>
            </span>
          }
        >
          {recent.error && !recent.data ? (
            <div className="flex flex-wrap items-center gap-2 px-2 py-4 text-xs text-failed"><span>Could not load runs and sessions: {recent.error}</span><Retry onRetry={recent.reload} /></div>
          ) : recent.loading && !recent.data ? (
            <p className="px-2 py-4 text-xs text-faint">loading…</p>
          ) : (
            <ItemTable
              items={shown}
              cap={50}
              onChanged={recent.reload}
              now={now}
              empty={filter ? "Nothing recent matches the status filter" : show !== "all" ? `No ${SHOW_LABEL[show]} sessions` : "No runs or sessions yet. Start a Claude Code session or pass --runs <dir>."}
            />
          )}
        </Panel>
      </div>
    </div>
  )
}
