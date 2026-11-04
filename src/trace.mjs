import { isSessionName } from "./names.mjs"
import { openStop, OWNER_RULES } from "./status.mjs"

// Turns a run's events (runs.jsonl) into a span tree for the Trace tab: run → stage → session →
// tool call, plus markers. Pure: no node: imports, so Node tests and the browser load the same file.
// Idle stretches over `breakAfterMs` (with no session open) are compressed to `breakMs`; t0/t1/t are
// compressed ms from the first event, realMs is the real duration. Errors are failures (non-owner
// stops, failed checks, agent-owned blocks); waits are owner stops.

// The transcript route's name check: a session transcript file in runs/<id>/sessions/.
export const safeSessionName = isSessionName

const tokensOf = (t = {}) => ({
  tokensIn: (t.input_tokens ?? 0) + (t.cache_creation_input_tokens ?? 0) + (t.cache_read_input_tokens ?? 0),
  tokensOut: t.output_tokens ?? 0,
})
const ms = (a, b) => Math.max(0, Date.parse(b) - Date.parse(a))
const short = (s, n = 90) => { s = String(s ?? ""); return s.length > n ? `${s.slice(0, n - 1)}…` : s }

export function buildTrace(events, { breakAfterMs = 120000, breakMs = 4000 } = {}) {
  const evs = (events ?? []).filter((e) => e && Number.isFinite(Date.parse(e.ts)))
    .map((e, i) => ({ e, i, at: Date.parse(e.ts) }))
    .sort((a, b) => a.at - b.at || a.i - b.i)
    .map((x) => x.e)
  if (!evs.length) return assemble(evs, [], [])
  // Real ms from the first event. A first pass on real time finds when sessions were open (start
  // marker seen, end not yet): a gap inside one is busy time, so it is never compressed.
  const R = evs.map((e) => Date.parse(e.ts) - Date.parse(evs[0].ts))
  const busy = []
  assemble(evs, R, [], busy)
  const T = new Array(evs.length)
  const breaks = []
  T[0] = 0
  let waiting = false // after an owner stop, until the run moves again
  for (let i = 1; i < evs.length; i++) {
    const p = evs[i - 1]
    if (p.type === "stop") waiting = OWNER_RULES.has(p.rule)
    else if (["human.input", "run.resume", "run.start", "stage.start"].includes(p.type)) waiting = false
    const d = R[i] - R[i - 1]
    const open = busy.some(([a, b]) => a <= R[i - 1] && b >= R[i])
    if (d > breakAfterMs && !open) { T[i] = T[i - 1] + breakMs; breaks.push({ t: T[i - 1], realMs: d, reason: waiting ? "waiting" : "idle" }) }
    else T[i] = T[i - 1] + d
  }
  return assemble(evs, T, breaks)
}

// Builds the trace from sorted events on the timeline T. `busy` (optional) collects the
// [t0, t1] of every session that has a start marker.
function assemble(evs, T, breaks, busy) {
  const trace = {
    title: "", status: "live", t0ts: evs[0]?.ts ?? null,
    totals: { durationMs: 0, cost: 0, tokensIn: 0, tokensOut: 0, llmCalls: 0, toolCalls: 0, errors: 0, waits: 0 },
    spans: [], markers: [], breaks, endT: 0,
  }
  if (!evs.length) return trace
  const endT = (trace.endT = T[evs.length - 1])
  const lastTs = evs[evs.length - 1].ts

  let seq = 0
  const mk = (kind, name, sub, o = {}) => ({
    id: `${kind}-${seq++}`, kind, name, sub: sub ?? "", t0: 0, t1: 0, realMs: 0, running: false, error: false,
    cost: 0, tokensIn: 0, tokensOut: 0, children: [], ...o,
  })

  // Pass 1: stage spans, session markers, sessions, tools, markers.
  const stages = [] // {span, stage, ts0, ts1|null, i0}
  const openStage = new Map()
  const startMarks = new Map() // sessionId -> {i, stage}
  const marksByStage = new Map() // stage -> [{id, i}], for session ends that carry no sessionId
  const sessions = [] // {i, e}
  const progress = [] // {i, e}  every progress event, for "ends at the next progress in that stage"
  const t = trace.totals
  const marker = (i, kind, label, stage) => trace.markers.push({ t: T[i], kind, label: short(label), stage: stage ?? "" })
  const close = (rec, i) => { rec.ts1 = evs[i].ts; rec.i1 = i; rec.span.t1 = T[i]; openStage.delete(rec.stage) }
  let lastStop = null
  evs.forEach((e, i) => {
    switch (e.type) {
      case "run.start": trace.title = short(e.idea, 120); break
      case "stage.start": {
        // A stage that starts again with its last run still open (cut by a crash): that run ends here.
        if (openStage.has(e.stage)) close(openStage.get(e.stage), i)
        const span = mk("stage", e.stage, e.attempt > 1 ? `attempt ${e.attempt}` : "", { t0: T[i] })
        const rec = { span, stage: e.stage, ts0: e.ts, ts1: null, i0: i }
        stages.push(rec); openStage.set(e.stage, rec)
        break
      }
      case "stage.end": {
        const rec = openStage.get(e.stage)
        if (rec) { rec.ts1 = e.ts; rec.i1 = i; rec.span.t1 = T[i]; rec.span.error = e.ok === false; openStage.delete(e.stage) }
        break
      }
      case "progress":
        progress.push({ i, e })
        if (e.tool === "session") { if (e.detail) {
          startMarks.set(e.detail, { i, stage: e.stage })
          if (!marksByStage.has(e.stage)) marksByStage.set(e.stage, [])
          marksByStage.get(e.stage).push({ id: e.detail, i })
        } }
        else t.toolCalls++
        break
      case "session": sessions.push({ i, e }); break
      case "stop":
        // An owner stop waits on you; any other rule (budget, unsure, stage-failed…) is a failure.
        lastStop = e
        if (OWNER_RULES.has(e.rule)) { t.waits++; marker(i, "wait", e.detail || "waits on you", e.stage) }
        else { t.errors++; marker(i, "stop", e.detail || e.rule || "stop", e.stage) }
        for (const rec of [...openStage.values()]) close(rec, i)
        break
      case "run.end": for (const rec of [...openStage.values()]) close(rec, i); break
      case "gap": marker(i, "gap", e.detail || "gap", e.stage); break
      case "issue": {
        // A human-owned block is the owner stop that follows it; an agent-owned block directly
        // followed by its stop counts once, as that stop.
        const next = evs[i + 1]
        if (e.decision?.blocks && e.decision.owner !== "human" && !(next?.type === "stop" && next.stage === e.stage)) {
          t.errors++; marker(i, "error", e.summary || "blocking issue", e.stage)
        }
        break
      }
      case "check":
        if (!e.skipped && e.exitCode !== 0 && e.exitCode !== undefined) { t.errors++; marker(i, "error", `check failed: ${e.cmd ?? ""}`, e.stage) }
        break
      case "human.input": marker(i, "human", e.text || "owner input", e.stage); break
      case "owner.question": marker(i, "question", e.text || "question", e.stage); break
      case "run.resume": marker(i, "resume", "resumed", e.stage); break
      default:
        if (typeof e.type === "string" && e.type.startsWith("consult.")) marker(i, "consult", `${e.type.slice(8)}: ${e.question || e.answer || e.id || ""}`, e.from ?? e.stage)
    }
  })
  const stageEnd = (rec) => rec.ts1 ? { t: rec.span.t1, ts: rec.ts1 } : { t: endT, ts: lastTs }
  // The stage run of `stage` that was open at event index i (latest started wins).
  const stageAt = (stage, i) => {
    for (let k = stages.length - 1; k >= 0; k--) {
      const r = stages[k]
      if (r.stage === stage && r.i0 <= i && (r.i1 === undefined || i <= r.i1)) return r
    }
    return null
  }

  // Sessions.
  // Spans with no stage run: consult-desk agents go under "consults", anything else under a group
  // named for its own stage (e.g. the post-run "learn" writeback).
  const CONSULT_DESK = ["researcher", "ux", "architect"]
  const groups = new Map()
  const orphan = (stage, span) => {
    const name = CONSULT_DESK.includes(stage) || !stage ? "consults" : stage
    if (!groups.has(name)) groups.set(name, [])
    groups.get(name).push(span)
  }
  const sessionsOf = new Map() // stage record -> its session spans, for the tool lookup
  const orphanSessions = new Map() // stage -> session spans with no stage run, for the tool lookup
  const orphanSess = (stage, s) => { if (!orphanSessions.has(stage)) orphanSessions.set(stage, []); orphanSessions.get(stage).push(s) }
  for (const rec of stages) if (!rec.ts1) rec.span.t1 = endT // open stages run to the cursor
  const lastEndIn = new Map() // stage span -> t of its previous session's end
  const sessSpans = []
  const used = new Set()
  for (const { i, e } of sessions) {
    const rec = stageAt(e.stage, i)
    let markId = e.sessionId && startMarks.has(e.sessionId) && !used.has(e.sessionId) ? e.sessionId : null
    if (!markId) {
      // No (known) sessionId, e.g. the learn writeback: claim the latest unclaimed start marker of
      // this stage before it, so the marker doesn't also become a ghost span running to the end.
      // Inside a stage run, only a marker from this run (not an earlier attempt's) can be claimed.
      const list = marksByStage.get(e.stage) ?? [], from = rec ? rec.i0 : -1
      for (let k = list.length - 1; k >= 0; k--) if (list[k].i < i && list[k].i >= from && !used.has(list[k].id)) { markId = list[k].id; break }
    }
    const mark = markId ? startMarks.get(markId) : null
    if (mark) used.add(markId)
    const tok = tokensOf(e.tokens)
    const t1 = T[i]
    let t0, realMs
    if (mark) { t0 = T[mark.i]; realMs = ms(evs[mark.i].ts, e.ts) }
    else if (rec) {
      const prev = lastEndIn.get(rec)
      t0 = prev ? Math.max(rec.span.t0, prev.t) : rec.span.t0
      realMs = ms(prev && prev.t >= rec.span.t0 ? prev.ts : rec.ts0, e.ts)
    } else { t0 = Math.max(0, t1 - 1000); realMs = 1000 }
    const s = mk("session", e.agent || e.stage || "session", e.model || e.runner || "", {
      t0: Math.min(t0, t1), t1, realMs, cost: e.cost || e.apiCost || 0, ...tok,
      error: (e.errors?.length ?? 0) > 0 || (e.outcome != null && !["success", "completed"].includes(e.outcome)),
      ref: e.transcript ? { transcript: e.transcript } : undefined,
    })
    if (!s.ref) delete s.ref
    t.cost += s.cost; t.tokensIn += s.tokensIn; t.tokensOut += s.tokensOut; t.llmCalls++
    s._i = i; s._ts1 = e.ts; s._mark = Boolean(mark)
    if (rec) {
      rec.span.children.push(s); lastEndIn.set(rec, { t: t1, ts: e.ts })
      if (!sessionsOf.has(rec)) sessionsOf.set(rec, [])
      sessionsOf.get(rec).push(s)
    } else { orphan(e.stage, s); orphanSess(e.stage, s) }
    sessSpans.push(s)
  }
  // A start marker with no session end: still running, or cut off with its stage. With no stage run
  // (memory, canary, archify sessions), it ends at the next boundary: another session starting or
  // ending, a stage starting or ending, the run ending or resuming, a stop, or an event named for its
  // stage (the canary/archify result). Only with no boundary yet is it running.
  const BOUNDARY = new Set(["session", "stage.start", "stage.end", "run.end", "run.resume", "stop"])
  const boundaryAfter = (mark) => {
    for (let j = mark.i + 1; j < evs.length; j++) {
      const x = evs[j]
      if (BOUNDARY.has(x.type) || x.type === mark.stage || (x.type === "progress" && x.tool === "session")) return { t: T[j], ts: x.ts }
    }
    return null
  }
  for (const [id, mark] of startMarks) {
    if (used.has(id)) continue
    const rec = stageAt(mark.stage, mark.i)
    const bound = rec ? null : boundaryAfter(mark)
    const end = rec ? stageEnd(rec) : bound ?? { t: endT, ts: lastTs }
    const running = rec ? !rec.ts1 : !bound
    const s = mk("session", mark.stage || "session", "", { t0: T[mark.i], t1: end.t, realMs: ms(evs[mark.i].ts, end.ts), running })
    s._i = mark.i; s._ts1 = end.ts; s._mark = true
    if (rec) {
      rec.span.children.push(s)
      if (!sessionsOf.has(rec)) sessionsOf.set(rec, [])
      sessionsOf.get(rec).push(s)
    } else { orphan(mark.stage, s); orphanSess(mark.stage, s) }
    sessSpans.push(s)
  }
  let slowest = null
  for (const s of sessSpans) if (!slowest || s.realMs > slowest.realMs) slowest = s
  if (slowest) slowest.slowest = true

  // Tool calls: end at the next progress in the same stage, capped at the session (or stage) end.
  const progByStage = new Map()
  for (const p of progress) { if (!progByStage.has(p.e.stage)) progByStage.set(p.e.stage, []); progByStage.get(p.e.stage).push(p) }
  for (const list of progByStage.values()) {
    list.forEach((p, k) => {
      if (p.e.tool === "session") return
      const rec = stageAt(p.e.stage, p.i)
      const t0 = T[p.i]
      const inside = (c) => c.t0 <= t0 && t0 <= c.t1
      const parent = rec ? ((sessionsOf.get(rec) ?? []).find(inside) ?? rec.span) : (orphanSessions.get(p.e.stage) ?? []).find(inside) ?? null
      const cap = parent ? parent.t1 : endT
      const open = parent ? parent.running || (parent === rec?.span && !rec.ts1) : true
      const next = list[k + 1]
      const t1 = Math.max(t0, next ? Math.min(T[next.i], cap) : cap)
      const span = mk("tool", p.e.tool, short(p.e.detail, 140), {
        t0, t1, realMs: ms(p.e.ts, next && T[next.i] <= cap ? next.e.ts : parent?._ts1 ?? rec?.ts1 ?? lastTs),
        running: !next && open, error: p.e.status === "error" || p.e.status === "failed",
      })
      if (parent) parent.children.push(span)
      else orphan(p.e.stage, span)
    })
  }

  // Roll up, then assemble the roots.
  for (const rec of stages) {
    const s = rec.span
    if (!rec.ts1) s.running = true
    s.realMs = ms(rec.ts0, rec.ts1 ?? lastTs)
    s.t1 = Math.max(s.t0, s.t1)
    for (const c of s.children) { s.cost += c.cost; s.tokensIn += c.tokensIn; s.tokensOut += c.tokensOut }
    s.children.sort((a, b) => a.t0 - b.t0 || a.t1 - b.t1)
  }
  const roots = stages.map((r) => r.span)
  for (const [name, kids] of groups) {
    kids.sort((a, b) => a.t0 - b.t0)
    const g = mk("group", name, "", {
      t0: kids[0].t0, t1: Math.max(...kids.map((c) => c.t1)), children: kids, running: kids.some((c) => c.running),
    })
    g.realMs = Math.max(...kids.map((c) => c.realMs))
    for (const c of kids) { g.cost += c.cost; g.tokensIn += c.tokensIn; g.tokensOut += c.tokensOut }
    roots.push(g)
  }
  roots.sort((a, b) => a.t0 - b.t0)
  trace.spans = roots
  for (const s of sessSpans) {
    if (busy && s._mark) busy.push([s.t0, s.t1])
    delete s._i; delete s._ts1; delete s._mark
  }

  // Status: the shared stop rule (src/status.mjs). An owner stop (rule "human" or "unverified") waits on you; any
  // other rule is stopped. Bookkeeping after the stop does not change that.
  const stop = openStop(evs)
  let lastMeaningful = null
  for (const e of evs) if (e.type !== "published") lastMeaningful = e
  trace.status = stop ? (OWNER_RULES.has(stop.rule) ? "waiting" : "stopped") : lastMeaningful?.type === "run.end" ? (lastMeaningful.status === "stopped" ? "stopped" : "done") : "live"
  t.durationMs = endT
  trace.markers.sort((a, b) => a.t - b.t)
  return trace
}
