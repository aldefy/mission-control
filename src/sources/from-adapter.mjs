import { askText, isWaiting, openAsk, openStop, OWNER_RULES } from "../status.mjs"
import { LOOP_DEFAULTS, applyLoops, runCalls } from "../loops.mjs"
import { defaultTz, localDay } from "../usage.mjs"

const zeroTokens = () => ({ in: 0, out: 0, cacheRead: 0, cacheWrite: 0 })
const num = (v) => (typeof v === "number" && Number.isFinite(v) ? v : 0)
const add = (a, b) => { a.in += b.in; a.out += b.out; a.cacheRead += b.cacheRead; a.cacheWrite += b.cacheWrite }
const str = (v) => (typeof v === "string" && v ? v : null)

/** v1 stage status -> v2 vocabulary. blocked is a halt that needs something else to change: stopped. */
const STAGE_STATUS = { running: "working", done: "done", stopped: "stopped", failed: "failed", blocked: "stopped" }

/** "mcp__server__tool" -> { server, tool }; anything else -> null. */
function parseMcp(tool) {
  const m = /^mcp__(.+?)__(.+)$/.exec(tool)
  return m ? { server: m[1], tool: m[2] } : null
}

function sessionTokens(t) {
  const o = t && typeof t === "object" ? t : {}
  return {
    in: num(o.input_tokens),
    out: num(o.output_tokens),
    cacheRead: num(o.cache_read_input_tokens),
    cacheWrite: num(o.cache_creation_input_tokens),
  }
}

/** Display label per stage from state.graph (id-keyed map or array of { id, label, stages }). */
function graphLabels(graph) {
  const labels = new Map()
  const nodes = graph?.nodes
  if (!nodes || typeof nodes !== "object") return labels
  const list = Array.isArray(nodes) ? nodes : Object.entries(nodes).map(([id, n]) => ({ id, ...n }))
  for (const n of list) {
    if (!n || typeof n.label !== "string") continue
    for (const s of Array.isArray(n.stages) ? n.stages : [n.id]) if (!labels.has(s)) labels.set(s, n.label)
  }
  return labels
}

function buildCalls(id, events) {
  const calls = []
  events.forEach((e, i) => {
    if (e.type !== "progress") return
    const tool = str(e.tool)
    const mcp = tool && parseMcp(tool)
    const call = {
      id: `${id}:${i}`,
      lane: str(e.stage) ?? "",
      ts: String(e.ts ?? ""),
      name: mcp ? mcp.tool : (tool ?? "progress"),
      kind: mcp ? "mcp" : "tool",
      summary: str(e.detail) ?? tool ?? "",
    }
    if (mcp) call.server = mcp.server
    calls.push(call)
  })
  return calls
}

/** Status of a stage that only appears in events: the open stop, else its last start/end. */
function eventStageStatus(id, events, stop, live) {
  if (stop && stop.stage === id) return OWNER_RULES.has(stop.rule) ? "waiting" : "stopped"
  let last = null
  for (const e of events) {
    if (e.stage !== id) continue
    if (e.type === "stage.start" || e.type === "stage.end") last = e
  }
  if (!last) return "idle"
  if (last.type === "stage.start") return live ? "working" : "idle"
  return last.ok === false ? "failed" : "done"
}

function buildLanes(state, events, calls, live) {
  const stop = openStop(events)
  const labels = graphLabels(state.graph)
  const lanes = Object.entries(state.stages && typeof state.stages === "object" ? state.stages : {}).map(([id, st]) => {
    // A stage left "running" in state on a run that is no longer live is not working: idle (the shared rule).
    const status = st?.status === "running" && !live ? "idle" : STAGE_STATUS[st?.status] ?? "idle"
    const lane = { id, label: labels.get(id) ?? id, kind: "stage", status, calls: 0, errors: 0, tokens: zeroTokens(), cost: 0 }
    if (stop && stop.stage === id && status !== "done" && status !== "failed") {
      lane.status = OWNER_RULES.has(stop.rule) ? "waiting" : "stopped"
    }
    return lane
  })
  // Stages seen only in events (real runs have some) get a lane of their own, in first-seen order.
  const known = new Set(lanes.map((l) => l.id))
  for (const e of events) {
    const id = str(e.stage)
    if (!id || known.has(id)) continue
    known.add(id)
    lanes.push({ id, label: labels.get(id) ?? id, kind: "stage", status: eventStageStatus(id, events, stop, live), calls: 0, errors: 0, tokens: zeroTokens(), cost: 0 })
  }
  for (const lane of lanes) {
    if (stop && stop.stage === lane.id && (lane.status === "waiting" || lane.status === "stopped") && typeof stop.detail === "string") lane.reason = stop.detail
    if (stop && stop.stage === lane.id && lane.status === "waiting" && typeof stop.ts === "string") lane.ask = { since: stop.ts }
  }
  // An agent paused on a question or permission request: its lane waits on you, with the question as why.
  const ask = openAsk(events)
  const asking = ask && lanes.find((l) => l.id === ask.stage)
  if (asking) {
    asking.status = "waiting"
    asking.reason = `${ask.stage} ${askText(ask)}`
    if (typeof ask.ts === "string") asking.ask = { since: ask.ts }
  }
  const byId = new Map(lanes.map((l) => [l.id, l]))
  for (const e of events) {
    const lane = byId.get(e.stage)
    if (!lane) continue
    if (e.type === "session") {
      add(lane.tokens, sessionTokens(e.tokens))
      lane.cost += num(e.cost)
      if (str(e.model)) lane.model = e.model
    } else if (e.type === "issue") lane.errors += 1
  }
  for (const c of calls) {
    const lane = byId.get(c.lane)
    if (!lane) continue
    lane.calls += 1
    lane.nowDoing = { name: c.name, kind: c.kind, summary: c.summary, ts: c.ts }
  }
  return lanes
}

function itemStatus({ live, waiting, events, lanes }) {
  if (waiting) return "waiting"
  if (live) return "working"
  if (lanes.some((l) => l.status === "failed")) return "failed"
  if (openStop(events) || lanes.some((l) => l.status === "stopped")) return "stopped"
  if (lanes.length && lanes.every((l) => l.status === "done" || l.status === "idle") && lanes.some((l) => l.status === "done")) return "done"
  return "idle"
}

/** Turn a v1 adapter ({ name, listRuns, getRun, getSession, extras?, actions?, describe? }) into a v2 Source. */
export function fromAdapter(adapter, { loops = () => LOOP_DEFAULTS, now = () => Date.now() } = {}) {
  const harnessName = adapter.harness ?? adapter.name

  function build(id, run) {
    const events = Array.isArray(run.events) ? run.events : []
    const state = run.state && typeof run.state === "object" ? run.state : {}
    const calls = buildCalls(id, events)
    const lanes = buildLanes(state, events, calls, Boolean(run.live))
    const waiting = isWaiting(events)
    const tokens = zeroTokens()
    let cost = 0
    for (const l of lanes) { add(tokens, l.tokens); cost += l.cost }
    // Session events with no stage at all still count toward the item.
    const known = new Set(lanes.map((l) => l.id))
    for (const e of events) {
      if (e.type === "session" && !known.has(e.stage)) { add(tokens, sessionTokens(e.tokens)); cost += num(e.cost) }
    }
    const stamps = events.map((e) => str(e.ts)).filter(Boolean)
    const live = Boolean(run.live)
    // Loops per stage lane, from progress / issue / stage.end / session events.
    const lp = applyLoops(lanes.map((lane) => ({ lane, ...runCalls(events, lane.id) })), { now: now(), config: loops(), detect: live && !waiting })
    const summary = {
      source: adapter.name,
      id,
      kind: "run",
      title: String(state.idea ?? state.title ?? id).slice(0, 160),
      harness: str(state.harness) ?? harnessName,
      cwd: str(state.repo) ?? str(state.worktree),
      branch: str(state.branch),
      live,
      status: itemStatus({ live, waiting, events, lanes }) === "working" && lp.loop ? "looping" : itemStatus({ live, waiting, events, lanes }),
      waiting,
      startedAt: stamps[0] ?? null,
      updatedAt: stamps.at(-1) ?? null,
      counts: { lanes: lanes.length, calls: calls.length, errors: lanes.reduce((n, l) => n + l.errors, 0) },
      tokens,
      cost,
      sinceChange: lp.sinceChange,
      ...(lp.loop ? { loop: lp.loop } : {}),
    }
    return { summary, lanes, events, state, calls }
  }

  async function load(id) {
    const run = await adapter.getRun(id)
    return run ? build(id, run) : null
  }

  return {
    name: adapter.name,
    harness: harnessName,
    adapter, // the v1 adapter behind this source, for the v1 route aliases
    describe: adapter.describe?.bind(adapter),
    extras: adapter.extras,
    actions: adapter.actions,
    ui: adapter.ui, // an ES module path: the adapter's own panes on the page (see uiModule in server.mjs)
    async listItems() {
      const runs = await adapter.listRuns()
      const items = await Promise.all(runs.map((r) => load(r.id)))
      return items.filter(Boolean).map((i) => i.summary)
    },
    async getItem(id) {
      const i = await load(id)
      return i && { summary: i.summary, lanes: i.lanes, events: i.events, state: i.state }
    },
    async getCalls(id, { lane, kind, q } = {}) {
      const i = await load(id)
      if (!i) return []
      const needle = q ? String(q).toLowerCase() : null
      return i.calls.filter(
        (c) =>
          (!lane || c.lane === lane) &&
          (!kind || c.kind === kind) &&
          (!needle || `${c.name} ${c.summary} ${c.server ?? ""}`.toLowerCase().includes(needle)),
      )
    },
    getSession: (id, name) => adapter.getSession(id, name),
    /** Per day per run per model, from the runs' `session` events (tokens, cost, model, ts). */
    async usage({ from, to, tz = defaultTz() } = {}) {
      const rows = new Map()
      const runs = await adapter.listRuns()
      for (const r of runs) {
        const i = await load(r.id)
        if (!i) continue
        const { cwd, branch, harness } = i.summary
        for (const e of i.events) {
          const ts = str(e.ts)
          if (e.type !== "session" || !ts) continue
          if (!Number.isFinite(Date.parse(ts))) continue
          const day = localDay(ts, tz)
          if ((from && day < from) || (to && day > to)) continue
          const model = str(e.model) ?? "unknown"
          const k = `${day}|${r.id}|${model}`
          const row = rows.get(k) ?? { day, source: adapter.name, harness, project: cwd ?? "", worktree: cwd ?? "", branch: branch ?? "", model, in: 0, out: 0, cacheRead: 0, cacheWrite: 0, cost: 0, sessions: 1, session: r.id }
          rows.set(k, row)
          add(row, sessionTokens(e.tokens))
          row.cost += num(e.cost)
        }
      }
      return [...rows.values()]
    },
  }
}
