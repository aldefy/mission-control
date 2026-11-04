type Ev = Record<string, any>

// The page targets ES2022, so no Array.prototype.findLast.
const lastIndex = (xs: Ev[], f: (e: Ev) => boolean) => { for (let i = xs.length - 1; i >= 0; i--) if (f(xs[i])) return i; return -1 }
const last = (xs: Ev[], f: (e: Ev) => boolean): Ev | undefined => xs[lastIndex(xs, f)]

export type RunBanner =
  | { kind: "done"; verified: boolean; branch: string | null; unverified: string[]; assumed: string[]; questions: string[]; findings: number }
  | { kind: "stopped"; rule: string; stage: string | null; detail: string }
  | { kind: "running"; stage: string | null; doing: string | null }
  | null

/** Events that clear a stop: once one follows it, the run is no longer waiting there (FORMAT.md rule). */
const CLEARS = new Set(["stage.start", "human.input", "run.resume", "run.start"])

/**
 * The one line the run page leads with, from the run's own events: finished (verified, or what nobody
 * verified), stopped for you (why), or running (which stage, doing what). Null before anything happened.
 */
export function runBanner(events: Ev[], live: boolean): RunBanner {
  let lastStop = -1, lastClear = -1, lastHandoff = -1
  events.forEach((e, i) => {
    if (e.type === "stop") lastStop = i
    else if (CLEARS.has(e.type)) lastClear = i
    if (e.type === "handoff") lastHandoff = i
  })
  if (lastStop > lastClear && lastStop > lastHandoff) {
    const s = events[lastStop]
    return { kind: "stopped", rule: String(s.rule ?? "stopped"), stage: s.stage ?? null, detail: String(s.detail ?? "") }
  }
  if (lastHandoff >= 0 && lastHandoff > lastClear) {
    const h = events[lastHandoff]
    return {
      kind: "done",
      verified: h.verified === true,
      branch: h.branch ?? null,
      unverified: Array.isArray(h.unverified) ? h.unverified.map(String) : [],
      assumed: Array.isArray(h.assumed) ? h.assumed.map(String) : [],
      questions: Array.isArray(h.questions) ? h.questions.map((q: Ev) => `${q.stage}: ${q.text}`) : [],
      findings: Array.isArray(h.findings) ? h.findings.length : 0,
    }
  }
  if (!live) return null
  const start = last(events, (e) => e.type === "stage.start")
  const doing = last(events, (e) => e.type === "progress" && (!start || e.stage === start.stage))
  return { kind: "running", stage: start?.stage ?? null, doing: doing ? `${doing.tool ? `${doing.tool}: ` : ""}${doing.detail ?? ""}`.slice(0, 160) : null }
}

/** The latest app screenshot the run took (frontend preview or QA), as a run-folder path. */
export function latestPreview(events: Ev[]): { path: string; v: string } | null {
  const p = last(events, (e) => e.type === "preview" && typeof e.png === "string")
  return p ? { path: p.png, v: String(p.v ?? p.ts ?? "") } : null
}

/** What QA is doing in its latest round, oldest first: each tool call, check and gap, for watching it work. */
export function qaActivity(events: Ev[]): { kind: string; text: string; ok?: boolean }[] {
  const at = lastIndex(events, (e) => e.type === "stage.start" && e.stage === "qa")
  if (at < 0) return []
  return events.slice(at + 1).flatMap((e) => {
    if (e.type === "progress" && e.stage === "qa" && e.tool !== "session") return [{ kind: String(e.tool ?? "step"), text: String(e.detail ?? "") }]
    if (e.type === "check" && e.stage === "qa") return [{ kind: "check", text: String(e.cmd ?? ""), ok: e.exitCode === 0 }]
    if (e.type === "gap" && (e.stage === "qa" || !e.stage)) return [{ kind: "not verified", text: String(e.detail ?? ""), ok: false }]
    return []
  })
}
