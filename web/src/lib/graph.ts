import { openStop, OWNER_RULES } from "../../../src/status.mjs"

// The crew as a graph (for the map) and as cards (for the sidebar), derived from a run's state and events.

type Ev = Record<string, any>
type State = Record<string, any>

export type GraphNode = { id: string; label: string; x: number; y: number; stages: string[] }
export type Hop = { from: string; to: string; kind: "sendback" | "consult"; ts: string; label?: string }
export type CrewGraph = { nodes: GraphNode[]; flow: [string, string][]; consult: [string, string][]; hops: Hop[] }

/** The map's coordinate space; a harness-supplied `state.graph` uses the same one. */
export const CANVAS = { w: 1000, h: 560 }

const pairs = (v: unknown): [string, string][] =>
  Array.isArray(v) ? v.filter((p) => Array.isArray(p) && p.length >= 2).map((p) => [String(p[0]), String(p[1])]) : []

function harnessGraph(g: any): Omit<CrewGraph, "hops"> | null {
  if (!g || typeof g !== "object" || !g.nodes) return null
  // Accept an array of nodes or an id-keyed map of them.
  const raw: any[] = Array.isArray(g.nodes) ? g.nodes : Object.entries(g.nodes).map(([id, n]: [string, any]) => ({ id, ...n }))
  const nodes = raw
    .filter((n) => n && typeof n.id === "string")
    .map((n) => ({
      id: n.id,
      label: String(n.label ?? n.id),
      x: Number(n.x) || 0,
      y: Number(n.y) || 0,
      stages: Array.isArray(n.stages) ? n.stages.map(String) : [n.id],
    }))
  return { nodes, flow: pairs(g.flow), consult: pairs(g.consult) }
}

/** Stage names in order: the state's own, then any that only appear in events. */
export function stageNames(state: State, events: Ev[]): string[] {
  const names = Object.keys(state?.stages ?? {})
  const seen = new Set(names)
  for (const e of events) {
    if (typeof e?.stage === "string" && e.stage && !seen.has(e.stage)) {
      seen.add(e.stage)
      names.push(e.stage)
    }
  }
  return names
}

function hopsOf(events: Ev[]): Hop[] {
  const hops: Hop[] = []
  for (const e of events) {
    const label = typeof e.id === "string" && e.id ? { label: e.id } : {}
    if (e.type === "issue" && e.decision?.blocks && e.decision.owner && e.decision.owner !== e.stage && e.stage)
      hops.push({ from: e.stage, to: String(e.decision.owner), kind: "sendback", ts: e.ts, ...label })
    if (e.type === "consult.asked" && e.to && (e.from ?? e.stage))
      hops.push({ from: String(e.from ?? e.stage), to: String(e.to), kind: "consult", ts: e.ts, ...label })
  }
  return hops
}

export function crewGraph(state: State, events: Ev[]): CrewGraph {
  const given = harnessGraph(state?.graph)
  const hops = hopsOf(events ?? [])
  if (given) return { ...given, hops }
  const names = stageNames(state, events ?? [])
  const n = names.length
  const nodes = names.map((id, i) => ({
    id,
    label: id,
    x: n === 1 ? CANVAS.w / 2 : 80 + (i * (CANVAS.w - 160)) / (n - 1),
    y: CANVAS.h / 2,
    stages: [id],
  }))
  const flow = names.slice(1).map((b, i) => [names[i], b] as [string, string])
  return { nodes, flow, consult: [], hops }
}

/** The node a stage belongs to. */
export const nodeOf = (g: CrewGraph, stage: string) =>
  g.nodes.find((n) => n.stages.includes(stage)) ?? g.nodes.find((n) => n.id === stage) ?? null

export type Stop = { stage?: string; rule?: string; detail?: string; ts?: string; waiting: boolean; /** answered by signing (Ronin's contract) */ sign?: boolean }

/** The stop the run is on now, by the shared rule (src/status.mjs): the last `stop` not followed by
 * stage.start, human.input, run.resume or run.start. `waiting` only for an owner stop (rule "human" or "unverified"). */
export function currentStop(_state: State, events: Ev[]): Stop | null {
  const e = openStop(events)
  return e ? { stage: e.stage, rule: e.rule, detail: e.detail, ts: e.ts, waiting: OWNER_RULES.has(String(e.rule)), ...(e.sign === true ? { sign: true } : {}) } : null
}

export type StageStatus = "running" | "stopped" | "done" | "skipped" | "failed" | "idle"

const FROM_STATE: Record<string, StageStatus> = {
  running: "running",
  stopped: "stopped",
  done: "done",
  skipped: "skipped",
  failed: "failed",
}

/** One stage's status: the state's word when it has one, else the stage's last lifecycle event.
 * Nothing runs in a run that is not live, so a leftover "running" (a crashed harness) is idle. */
export function stageStatus(state: State, events: Ev[], live: boolean, stage: string): StageStatus {
  const s = FROM_STATE[state?.stages?.[stage]?.status]
  if (s) return s === "running" && !live ? "idle" : s
  let last: StageStatus = "idle"
  for (const e of events) {
    if (e.stage !== stage) continue
    if (e.type === "stage.start") last = live ? "running" : "idle"
    else if (e.type === "stage.end") last = e.ok === false ? "failed" : "done"
    else if (e.type === "stage.skipped") last = "skipped"
  }
  return last
}

export type CardStatus = "needs-you" | "running" | "failed" | "idle" | "done" | "skipped"
export type Chip = { kind: Hop["kind"]; text: string }
export type CrewCard = { node: GraphNode; status: CardStatus; rounds: number; line: string; chip: Chip | null; stage: string }

function findLast<T>(xs: T[], ok: (x: T) => unknown): T | undefined {
  for (let i = xs.length - 1; i >= 0; i--) if (ok(xs[i])) return xs[i]
  return undefined
}

const time = (ts: unknown) => {
  const t = Date.parse(String(ts))
  return Number.isFinite(t) ? t : NaN
}
const after = (a: unknown, b: unknown) => {
  const ta = time(a), tb = time(b)
  return Number.isFinite(ta) && Number.isFinite(tb) ? ta > tb : String(a) > String(b)
}

export function crewCards(g: CrewGraph, state: State, events: Ev[], live: boolean, stop = currentStop(state, events)): CrewCard[] {
  return g.nodes.map((node) => {
    const has = (s: unknown) => typeof s === "string" && (node.stages.includes(s) || s === node.id)
    const statuses = node.stages.map((s) => stageStatus(state, events, live, s))
    const mine = events.filter((e) => has(e.stage))
    // Waiting on you only by the shared rule; a stage stopped any other way (or marked stopped in
    // the state with no owner stop open) has failed.
    const here = !!stop?.stage && has(stop.stage)
    const needs = here && stop!.waiting
    const halted = !needs && (here || statuses.includes("stopped"))

    let status: CardStatus = "idle"
    if (needs) status = "needs-you"
    else if (halted) status = "failed"
    else if (statuses.includes("running")) status = "running"
    else if (statuses.includes("failed")) status = "failed"
    else if (statuses.length && statuses.every((s) => s === "skipped")) status = "skipped"
    else if (statuses.length && statuses.every((s) => s === "done" || s === "skipped")) status = "done"

    const fromState = Math.max(0, ...node.stages.map((s) => Number(state?.stages?.[s]?.rounds) || 0))
    const rounds = fromState || mine.filter((e) => e.type === "stage.start").length

    const progress = findLast(mine, (e) => e.type === "progress" && e.detail)?.detail
    const failure = findLast(mine, (e) => e.type === "stage.end" && e.ok === false)
    const line =
      status === "needs-you" ? "needs you"
      : status === "running" ? String(progress ?? "working")
      : halted ? `stopped${here && stop!.rule ? ` (${stop!.rule})` : ""}`
      : status === "failed" ? `failed${failure?.reason ? `: ${failure.reason}` : ""}`
      : status === "skipped" ? "skipped"
      : status === "done" ? "done"
      : mine.length ? String(progress ?? "waiting") : "not started"

    // Why it is working: the latest hop into it, unless it has finished a round since.
    const lastEnd = findLast(mine, (e) => e.type === "stage.end")?.ts
    const hop = findLast(g.hops, (h) => has(h.to))
    const fresh = hop && status !== "done" && status !== "skipped" && (lastEnd === undefined || after(hop.ts, lastEnd))
    const chip: Chip | null = !fresh
      ? null
      : hop.kind === "sendback"
        ? { kind: "sendback", text: `fix${hop.label ? ` ${hop.label}` : ""} · ${hop.from}` }
        : { kind: "consult", text: `${hop.label ?? "question"} · ${hop.from}` }

    const active = node.stages.find((_, i) => statuses[i] === "running" || statuses[i] === "stopped")
    const lastTouched = findLast(mine, (e) => typeof e.stage === "string" && node.stages.includes(e.stage))?.stage
    const stage = (stop?.stage && node.stages.includes(stop.stage) ? stop.stage : undefined) ?? active ?? lastTouched ?? node.stages[0] ?? node.id

    return { node, status, rounds, line, chip, stage }
  })
}
