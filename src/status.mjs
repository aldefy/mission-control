// The one "waiting on you" rule, shared by the trace, the adapters' run summaries and the page.
// Pure: no node: imports, so Node and the browser bundle load the same file.
//
// A run's current stop is its last `stop` event not followed by stage.start, human.input,
// run.resume or run.start. It waits on you when that stop's rule is an owner rule ("human", or
// "unverified": a stage left things nobody verified); any other rule (budget, stage-failed, …) is
// stopped, not waiting. A run also waits on you while an agent inside it asks something: a
// `question.asked` or `approval.needed` event that no answer (same id) or end of that stage followed.

const CLEARS = new Set(["stage.start", "human.input", "run.resume", "run.start"])

/** The stop the run is on now (the event itself), or null. Events in file order. */
export function openStop(events) {
  let stop = null
  for (const e of events ?? []) {
    if (!e || typeof e !== "object") continue
    if (e.type === "stop") stop = e
    else if (CLEARS.has(e.type)) stop = null
  }
  return stop
}

/** Stop rules the owner must act on: they make the run wait on you. */
export const OWNER_RULES = new Set(["human", "unverified"])

const ASKS = new Set(["question.asked", "approval.needed"])
const ANSWERS = new Set(["question.answered", "approval"])

/**
 * The agent question or permission request the run is paused on now (the event), or null. `state`: the run's
 * state, whose `answers` / `approvals` hold an answer the moment you give it (before the agent acknowledges it).
 */
export function openAsk(events, state = null) {
  const given = new Set([...Object.keys(state?.answers ?? {}), ...Object.keys(state?.approvals ?? {})])
  const open = new Map()
  for (const e of events ?? []) {
    if (!e || typeof e !== "object") continue
    if (ASKS.has(e.type) && e.id != null) open.set(String(e.id), e)
    else if (ANSWERS.has(e.type) && e.id != null) open.delete(String(e.id))
    else if (e.type === "stage.end" || e.type === "stop") { for (const [k, a] of open) if (a.stage === e.stage || e.type === "stop") open.delete(k) }
    else if (e.type === "run.start" || e.type === "run.resume" || e.type === "run.end") open.clear()
  }
  return [...open.values()].filter((a) => !given.has(String(a.id))).at(-1) ?? null
}

/** One line for what an agent asks: how many questions and the first one, or the action it wants permission for. */
export function askText(a) {
  if (!a) return ""
  if (a.type === "approval.needed") return `wants to ${a.action ?? "do something"}${a.resources?.length ? `: ${a.resources.join(", ")}` : ""}`
  const fields = Array.isArray(a.fields) ? a.fields : []
  const f = fields[0]
  // The first field's own question (its description's first sentence) says most; titles are often generic ("Questions").
  const first = (x) => (typeof x === "string" ? x.trim().split(/(?<=[?.!])\s/)[0] : "")
  const q = first(f?.description) || first(f?.title) || first(a.title)
  const n = fields.length
  return q ? `asks${n > 1 ? ` ${n} questions` : ""}: ${q}` : "asks you something"
}

/** True when the run waits on you: an owner stop, or an agent question nobody answered yet. */
export const isWaiting = (events, state = null) => OWNER_RULES.has(openStop(events)?.rule) || openAsk(events, state) !== null
