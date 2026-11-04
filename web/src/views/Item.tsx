import { useEffect, useMemo, useState } from "react"
import { Pencil } from "lucide-react"
import { RenameForm } from "@/components/RenameForm"
import { CopyResume } from "@/components/CopyResume"
import { IconAction } from "@/components/IconAction"
import { Retry } from "@/components/Retry"
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
import { Skeleton } from "@/components/ui/skeleton"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { FlowStrip } from "@/components/FlowStrip"
import { ItemMap } from "@/components/ItemMap"
import { ExpandButton, GraphOverlay, type OverlayStart } from "@/components/GraphOverlay"
import { LaneTimeline } from "@/components/LaneTimeline"
import { LaneCards } from "@/components/LaneCards"
import { LaneSheet } from "@/components/LaneSheet"
import { RightRail } from "@/components/RightRail"
import { StatusDot } from "@/components/StatusDot"
import { STATUS_UI } from "@/lib/status-ui"
import { SummaryStrip } from "@/components/SummaryStrip"
import { Thread } from "@/components/Thread"
import { TokenPanel } from "@/components/TokenPanel"
import Board from "@/views/Board"
import Calls from "@/views/Calls"
import Chat from "@/views/Chat"
import DiffView from "@/views/Diff"
import Docs from "@/views/Docs"
import Qa from "@/views/Qa"
import Trace from "@/views/Trace"
import Turns from "@/views/Turns"
import { useCalls, useCapabilities, useExtra, useItem, useSources, type ItemDetail } from "@/lib/api"
import { useItemConfig, useItemConflicts } from "@/lib/api-v22"
import { SameFileWarnings } from "@/components/SameFileWarnings"
import { extraTabs, normaliseDiff, normaliseTasks, qaRows, runChanges } from "@/lib/extras"
import { ago, useNow } from "@/lib/format"
import { crewCards, crewGraph, currentStop } from "@/lib/graph"
import { laneExtras } from "@/lib/item"
import { laneLinks } from "@/lib/map"
import { toHash } from "@/lib/route"
import { cn } from "@/lib/utils"
import { BP, useMedia } from "@/lib/media"

const LIVE_POLL = 2000
const IDLE_POLL = 10000
/** The full-screen map opens readable (≥80%) on the node that needs you, else the working one. */
const MAP_START: OverlayStart = { minK: 0.8, focus: ['[data-node]:not([data-node="you"])[data-status="waiting"]', '[data-node][data-status="working"]'] }

/** The tabs an item shows: the v2 four plus a v1 run's extras when its adapter lists them. */
export function itemTabs(o: { v1Run: boolean; extras: string[]; events: Record<string, any>[]; turns?: boolean }): string[] {
  const has = o.v1Run ? extraTabs(o.extras, o.events) : { board: false, qa: qaRows(o.events) !== null, diff: false, docs: false }
  return ["lanes", "map", "calls", "timeline", ...(o.turns ? ["turns"] : []), "chat", ...(has.board ? ["board"] : []), ...(has.qa ? ["qa"] : []), ...(has.diff ? ["diff"] : []), ...(has.docs ? ["docs"] : [])]
}

const LABEL: Record<string, string> = { turns: "Turns", lanes: "Lanes", map: "Map", calls: "Calls", timeline: "Timeline", chat: "Chat", board: "Board", qa: "QA", diff: "Diff", docs: "Docs" }

const Count = ({ n }: { n: number | null | undefined }) => (n ? <span className="ml-1 font-mono text-xs text-muted-foreground">{n}</span> : null)
const TaskCount = ({ id, refresh }: { id: string; refresh: number }) => <Count n={normaliseTasks(useExtra<unknown>("tasks", id, undefined, refresh).data).length} />
const DiffCount = ({ id, refresh }: { id: string; refresh: number }) => <Count n={normaliseDiff(useExtra<unknown>("diff", id, undefined, refresh).data).files.length} />

function Title({ s, onRenamed }: { s: ItemDetail["summary"]; onRenamed: () => void }) {
  const [editing, setEditing] = useState(false)
  if (editing) {
    return (
      <RenameForm
        source={s.source}
        id={s.id}
        title={s.title}
        renamed={s.originalTitle !== undefined}
        onDone={() => { setEditing(false); onRenamed() }}
        onCancel={() => setEditing(false)}
      />
    )
  }
  return (
    <div className="flex min-w-0 flex-1 items-center gap-1">
      <h1 className="line-clamp-2 min-w-0 text-lg font-bold tracking-tight [text-wrap:balance]" title={s.originalTitle ?? s.title}>
        {s.title || s.id}
      </h1>
      <IconAction label="Rename" onClick={() => setEditing(true)}>
        <Pencil />
      </IconAction>
    </div>
  )
}

function Header({ d, onRenamed }: { d: ItemDetail; onRenamed: () => void }) {
  const s = d.summary
  // One status word in its own colour; "live" is a separate neutral tag, never mixed into the status pill.
  const shown = s.live && s.status !== "waiting" && s.status !== "looping" && s.status !== "idle" && s.status !== "failed" ? "working" : s.status
  return (
    <header className="flex flex-wrap items-center gap-x-3 gap-y-1">
      <Title s={s} onRenamed={onRenamed} />
      <span className="font-mono text-xs text-faint">
        {s.harness} · {s.kind}
        {s.branch ? ` · ${s.branch}` : ""}
      </span>
      <span data-status-pill className={cn("flex items-center gap-1.5 rounded-full border px-2 py-0.5 font-mono text-xs", STATUS_UI[shown].border, STATUS_UI[shown].text)}>
        <StatusDot status={shown} labelled />
        {STATUS_UI[shown].label}
      </span>
      {s.live && s.status !== "idle" && (
        <span data-live-tag className="mc-live rounded-full border border-border px-2 py-0.5 font-mono text-xs text-faint">live</span>
      )}
      {s.parkedInto && (
        <p className="basis-full text-xs text-muted-foreground">
          The chat continues under a new session id; this is its earlier part. Lists show it once, under the new id.{" "}
          <a className="underline hover:text-foreground" href={toHash({ view: "item", source: s.source, id: s.parkedInto, tab: "chat" })}>Open the latest part</a>
        </p>
      )}
      {s.continuedFrom && (
        <p className="basis-full text-xs text-muted-foreground">
          Same chat, new session id: Claude Code switched ids partway through. The earlier messages are under the old id.{" "}
          <a className="underline hover:text-foreground" href={toHash({ view: "item", source: s.source, id: s.continuedFrom, tab: "chat" })}>Open the earlier part</a>
        </p>
      )}
      {s.resume && <CopyResume full command={s.resume} open={s.open} className="basis-full" />}
    </header>
  )
}

/** The item page: summary strip, tabs (Lanes default), and the right rail. Works for every source. */
export default function Item({ source, id, tab, call }: { source: string; id: string; tab: string; call?: string }) {
  const [poll, setPoll] = useState(LIVE_POLL)
  const item = useItem(source, id, poll)
  const d = item.data
  const live = d?.summary.live ?? true
  useEffect(() => setPoll(live ? LIVE_POLL : IDLE_POLL), [live])
  const caps = useCapabilities()
  const sources = useSources()
  const isSession = d?.summary.kind === "session"
  // Sessions read health and findings from their calls (a run's come from its events); any item's timeline
  // draws them, and the Calls tab lists them: one poller for all three.
  const calls = useCalls(source, isSession || tab === "timeline" || tab === "calls" ? id : null, {}, poll)
  const now = useNow(5000)
  const conflicts = useItemConflicts(source, id)
  const config = useItemConfig(source, isSession && tab === "calls" ? id : null, d?.summary.counts?.calls ?? 0)
  const [sheet, setSheet] = useState<string[] | null>(null)
  const [focus, setFocus] = useState<{ ids: string[]; n: number } | null>(null)
  const [youFlash, setYouFlash] = useState(0)
  const desktop = useMedia(BP.lg)
  const [mapFull, setMapFull] = useState(false)
  const [hoverLane, setHoverLane] = useState<string | null>(null)

  const src = sources.data?.find((s) => s.name === source)
  const actions = src?.actions ?? []
  const v1Run = !!d && d.summary.kind === "run" && caps.data?.adapter === source
  const events = useMemo(() => (Array.isArray(d?.events) ? d!.events : []), [d])
  const extras = useMemo(() => (d ? laneExtras(d) : new Map()), [d])
  const links = useMemo(() => (d ? laneLinks(d) : []), [d])
  const v1 = useMemo(() => {
    if (!d || !v1Run) return null
    const state = d.state ?? {}
    const graph = crewGraph(state, events)
    const stop = currentStop(state, events)
    return { state, stop, cards: crewCards(graph, state, events, d.summary.live, stop), refresh: runChanges(events) }
  }, [d, v1Run, events])

  if (item.loading && !d) return <Skeleton className="h-64 w-full" />
  if (!d)
    return (
      <Alert variant="destructive">
        <AlertTitle>Could not load {source} · {id}</AlertTitle>
        <AlertDescription className="flex flex-wrap items-center gap-3">{item.error ?? "no such item"}<Retry onRetry={item.reload} /></AlertDescription>
      </Alert>
    )

  const tabs = itemTabs({ v1Run, extras: src?.extras ?? caps.data?.extras ?? [], events, turns: isSession && (d.summary.harness === "claude-code" || d.summary.harness === "codex") })
  const current = tabs.includes(tab) ? tab : "lanes"
  const go = (t: string) => (location.hash = toHash({ view: "item", source, id, tab: t }))
  const lanesFor = (ids: string[] | null) => (ids ? d.lanes.filter((l) => ids.includes(l.id)) : [])
  const wide = current === "calls"
  const idea = String(d.state?.idea ?? d.summary.title ?? "")
  // "you" on the map: the rail scrolls to and flashes its needs-you card (or itself when nothing waits).
  const toYou = () => setYouFlash((n) => n + 1)

  return (
    <div className="mx-auto flex max-w-[1500px] flex-col gap-4">
      <Header d={d} onRenamed={item.reload} />
      {d.summary.recap && (
        <section aria-label="Recap" className="rounded-lg border bg-card px-3 py-2 text-sm">
          <span className="mr-2 font-mono text-xs text-faint">recap{d.summary.recap.ts ? ` · ${ago(d.summary.recap.ts, now)} ago` : ""}</span>
          {d.summary.recap.text}
        </section>
      )}
      <SummaryStrip detail={d} now={now} />
      {!desktop && <RightRail part="ask" detail={d} calls={null} actions={actions} now={now} onActed={item.reload} flash={youFlash} />}
      <div className={cn("grid gap-6", !wide && "lg:grid-cols-[minmax(0,1fr)_320px]")}>
        <Tabs value={current} onValueChange={(v) => go(String(v))} className="min-w-0">
          <TabsList variant="line" className="border-b">
            {tabs.map((t) => (
              <TabsTrigger key={t} value={t}>
                {LABEL[t] ?? t}
                {t === "lanes" && <Count n={d.lanes.length} />}
                {t === "calls" && <Count n={d.summary.counts?.calls} />}
                {t === "board" && <TaskCount id={id} refresh={v1?.refresh ?? 0} />}
                {t === "qa" && <Count n={qaRows(events)?.length} />}
                {t === "diff" && <DiffCount id={id} refresh={v1?.refresh ?? 0} />}
              </TabsTrigger>
            ))}
          </TabsList>
          <TabsContent value="lanes" className="flex flex-col gap-4 pt-4">
            {d.lanes.length > 1 && <FlowStrip detail={d} now={now} onPick={(ids) => setFocus({ ids, n: Date.now() })} onYou={toYou} highlight={hoverLane} />}
            <LaneCards lanes={d.lanes} extras={extras} now={now} links={links} focus={focus} onOpen={(lane) => setSheet([lane])} onHover={setHoverLane} callHref={(c) => toHash({ view: "item", source, id, tab: "calls", call: c })} />
          </TabsContent>
          <TabsContent value="map" className="relative pt-4">
            <div className="absolute top-6 right-2 z-[2]">
              <ExpandButton onClick={() => setMapFull(true)} />
            </div>
            <ItemMap detail={d} extras={extras} selected={sheet?.[0]} onOpen={setSheet} onYou={toYou} />
            {mapFull && (
              <GraphOverlay title={`Map · ${d.summary.title || d.summary.id}`} onClose={() => setMapFull(false)} start={MAP_START}>
                <div className="p-4">
                  <ItemMap
                    natural
                    fullLabels
                    detail={d}
                    extras={extras}
                    selected={sheet?.[0]}
                    onOpen={(ids) => {
                      setMapFull(false)
                      setSheet(ids)
                    }}
                    onYou={() => {
                      setMapFull(false)
                      toYou()
                    }}
                  />
                </div>
              </GraphOverlay>
            )}
          </TabsContent>
          <TabsContent value="calls" className="pt-4">
            {current === "calls" && (
              <div className="h-[78vh] min-h-[520px] overflow-hidden rounded-xl border bg-card/30">
                <Calls source={source} id={id} call={call} detail={d} calls={calls.data ?? null} callsError={calls.error} onRetry={calls.reload} config={config.data} />
              </div>
            )}
          </TabsContent>
          <TabsContent value="timeline" className="pt-4">
            {current === "timeline" &&
              (v1Run && events.length > 0 ? (
                <Trace runId={id} events={events} live={d.summary.live} idea={idea} />
              ) : calls.loading && !calls.data && d.lanes.length > 0 ? (
                <Skeleton className="h-64 w-full" />
              ) : (
                <LaneTimeline lanes={d.lanes} calls={calls.data ?? []} live={d.summary.live} now={now} onPick={(c) => (location.hash = toHash({ view: "item", source, id, tab: "calls", call: c.id }))} onOpenLane={(lane) => setSheet([lane])} />
              ))}
          </TabsContent>
          {tabs.includes("turns") && (
            <TabsContent value="turns" className="pt-4">
              {current === "turns" && <Turns source={source} id={id} lanes={d.lanes} live={d.summary.live} />}
            </TabsContent>
          )}
          <TabsContent value="chat" className="pt-4">
            {current === "chat" &&
              (v1Run && v1 ? (
                <Thread runId={id} idea={idea} events={events} stop={v1.stop} cards={v1.cards} canSay={actions.includes("say")} />
              ) : (
                <Chat source={source} id={id} lanes={d.lanes} live={d.summary.live} calls={calls.data} />
              ))}
          </TabsContent>
          {tabs.includes("board") && v1 && (
            <TabsContent value="board" className="pt-4">
              <Board runId={id} cards={v1.cards} refresh={v1.refresh} />
            </TabsContent>
          )}
          {tabs.includes("qa") && (
            <TabsContent value="qa" className="pt-4">
              <Qa events={events} />
            </TabsContent>
          )}
          {tabs.includes("diff") && v1 && (
            <TabsContent value="diff" className="pt-4">
              <DiffView runId={id} refresh={v1.refresh} />
            </TabsContent>
          )}
          {tabs.includes("docs") && v1 && (
            <TabsContent value="docs" className="pt-4">
              <Docs runId={id} state={v1.state} />
            </TabsContent>
          )}
        </Tabs>
        {!wide && (
          <div className="flex flex-col gap-4 lg:sticky lg:top-0 lg:self-start">
            <SameFileWarnings warnings={conflicts.data?.warnings ?? []} self={{ source, id }} />
            <RightRail part={desktop ? "all" : "rest"} detail={d} calls={isSession ? calls.data : null} actions={actions} now={now} onActed={item.reload} onOpen={(lane) => setSheet([lane])} flash={desktop ? youFlash : 0} />
            {v1Run && (src?.extras ?? []).includes("tokens") && !tabs.includes("docs") && <TokenPanel runId={id} optional />}
          </div>
        )}
      </div>
      <LaneSheet detail={d} lanes={lanesFor(sheet)} onClose={() => setSheet(null)} />
    </div>
  )
}
