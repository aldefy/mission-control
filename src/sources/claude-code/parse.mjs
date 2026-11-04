import { costOf } from "./prices.mjs"

const zero = () => ({ in: 0, out: 0, cacheRead: 0, cacheWrite: 0 })
const num = (v) => (typeof v === "number" && Number.isFinite(v) ? v : 0)
const str = (v) => (typeof v === "string" && v ? v : null)
const clip = (s, n) => (s.length > n ? `${s.slice(0, n - 1)}…` : s)

/** Parse JSONL leniently: a half-written last line (or any bad line) is skipped, never thrown. */
export function* lines(text) {
  for (const raw of String(text).split("\n")) {
    if (!raw.trim()) continue
    let e
    try { e = JSON.parse(raw) } catch { continue }
    if (e && typeof e === "object" && !Array.isArray(e)) yield e
  }
}

function userText(e) {
  if (e.type !== "user" || e.isMeta) return null
  const c = e.message?.content
  const text = typeof c === "string" ? c : Array.isArray(c) ? c.filter((b) => b?.type === "text").map((b) => b.text).join(" ") : ""
  const t = text.replace(/\s+/g, " ").trim()
  return t && !t.startsWith("<system-reminder>") ? t : null
}

/** Cheap look at the head of a file: cwd, branch, version, title, first timestamp. */
export function peek(text) {
  const out = { cwd: null, branch: null, version: null, sessionId: null, title: null, summary: null, customTitle: null, aiTitle: null, startedAt: null }
  let firstUser = null
  for (const e of lines(text)) {
    out.cwd ??= str(e.cwd)
    out.branch ??= str(e.gitBranch)
    out.version ??= str(e.version)
    out.sessionId ??= str(e.sessionId)
    out.startedAt ??= str(e.timestamp)
    if (e.type === "summary") out.summary ??= str(e.summary)
    if (e.type === "custom-title") out.customTitle = str(e.customTitle) ?? out.customTitle
    if (e.type === "ai-title") out.aiTitle = str(e.aiTitle) ?? out.aiTitle
    firstUser ??= userText(e)
  }
  out.title = clip(out.customTitle ?? out.aiTitle ?? out.summary ?? firstUser ?? "", 160) || null
  return out
}

/** One-line description of a tool call's input. */
export function summarize(name, input) {
  const i = input && typeof input === "object" ? input : {}
  const pick = i.command ?? i.file_path ?? i.path ?? i.pattern ?? i.description ?? i.url ?? i.query ?? i.skill ??
    Object.values(i).find((v) => typeof v === "string")
  return clip(String(pick ?? name).split("\n")[0], 140)
}

function capInput(input) {
  if (!input || typeof input !== "object") return input
  const o = {}
  for (const [k, v] of Object.entries(input)) o[k] = typeof v === "string" ? clip(v, 500) : v
  return o
}

function resultText(c) {
  if (typeof c === "string") return c
  if (Array.isArray(c)) return c.map((b) => (typeof b === "string" ? b : b?.text ?? "")).join("\n")
  return ""
}

/** Classify a tool_use name. mcp__srv__tool -> mcp; Skill -> skill; Agent/Task -> agent. */
export function classify(name, input) {
  const m = /^mcp__(.+?)__(.+)$/.exec(name)
  if (m) return { kind: "mcp", server: m[1], name: m[2] }
  if (name === "Skill") return { kind: "skill", name: str(input?.skill) ?? "Skill" }
  if (name === "Agent" || name === "Task") return { kind: "agent", name }
  return { kind: "tool", name }
}

/**
 * Parse one transcript. Token usage is counted once per assistant message id (Claude Code writes one
 * line per content block, each repeating the message's usage); the last usage seen for an id wins.
 * Calls are matched to their tool_result by tool_use_id for ok/error, duration and a short result.
 */
export function parseTranscript(text, laneId = "main") {
  const acc = transcriptAcc(laneId)
  for (const e of lines(text)) acc.feed(e)
  return acc.result()
}

/**
 * parseTranscript as an accumulator: feed(entry) one parsed line at a time (so a growing file is parsed
 * only for its new lines), result() whenever a snapshot is needed. result() never mutates the state.
 */
export function transcriptAcc(laneId = "main") {
  const calls = []
  const byUse = new Map()
  const msgs = new Map() // message key -> { model, usage }
  let anon = 0
  const meta = { cwd: null, branch: null, version: null, sessionId: null, summary: null, customTitle: null, aiTitle: null, recap: null, title: null }
  let firstTs = null, lastTs = null, firstModel = null, errors = 0, firstUser = null
  function feed(e) {
    const ts = str(e.timestamp)
    if (ts) { firstTs ??= ts; lastTs = ts }
    meta.cwd ??= str(e.cwd)
    meta.branch ??= str(e.gitBranch)
    meta.version ??= str(e.version)
    meta.sessionId ??= str(e.sessionId)
    if (e.type === "summary") meta.summary ??= str(e.summary)
    if (e.type === "custom-title") meta.customTitle = str(e.customTitle) ?? meta.customTitle
    if (e.type === "ai-title") meta.aiTitle = str(e.aiTitle) ?? meta.aiTitle
    // A recap Claude Code writes when you come back to a session: where things stand and what is next.
    if (e.type === "system" && e.subtype === "away_summary" && str(e.content)) {
      meta.recap = { text: e.content.replace(/\s*\(disable recaps in \/config\)\s*$/, ""), ts: ts ?? null }
    }
    firstUser ??= userText(e)
    const m = e.message && typeof e.message === "object" ? e.message : null
    if (e.type === "assistant" && m) {
      const model = str(m.model)
      firstModel ??= model
      const key = str(m.id) ?? `anon${anon++}`
      msgs.set(key, { model, usage: m.usage ?? {}, ts: msgs.get(key)?.ts ?? ts }) // last usage wins, first timestamp stays
      for (const b of Array.isArray(m.content) ? m.content : []) {
        if (b?.type !== "tool_use" || typeof b.name !== "string") continue
        const c = classify(b.name, b.input)
        const call = { id: str(b.id) ?? `${laneId}:${calls.length}`, lane: laneId, ts: ts ?? "", name: c.name, kind: c.kind, summary: summarize(b.name, b.input) }
        if (c.server) call.server = c.server
        if (b.input !== undefined) call.input = capInput(b.input)
        calls.push(call)
        if (str(b.id)) byUse.set(b.id, { call, at: ts })
      }
    } else if (e.type === "user" && Array.isArray(m?.content)) {
      for (const b of m.content) {
        if (b?.type !== "tool_result") continue
        const hit = byUse.get(b.tool_use_id)
        const bad = b.is_error === true
        if (bad) errors++
        if (!hit) continue
        const body = clip(resultText(b.content).trim(), 200)
        hit.call.ok = !bad
        if (bad) hit.call.error = body || "error"
        else if (body) hit.call.result = body
        const d = Date.parse(ts ?? "") - Date.parse(hit.at ?? "")
        if (Number.isFinite(d) && d >= 0) hit.call.durationMs = d
      }
    }
  }
  function result() {
    const tokens = zero()
    const models = {}
    const messages = [] // one per assistant message id, for per-day usage
    let cost = 0
    for (const { model, usage, ts } of msgs.values()) {
      const t = { in: num(usage.input_tokens), out: num(usage.output_tokens), cacheRead: num(usage.cache_read_input_tokens), cacheWrite: num(usage.cache_creation_input_tokens) }
      tokens.in += t.in; tokens.out += t.out; tokens.cacheRead += t.cacheRead; tokens.cacheWrite += t.cacheWrite
      cost += costOf(model, t)
      messages.push({ model, ts: ts ?? null, tokens: t })
      if (model) models[model] = (models[model] ?? 0) + 1
    }
    const out = { ...meta, title: clip(meta.customTitle ?? meta.aiTitle ?? meta.summary ?? firstUser ?? "", 160) || null }
    // Snapshot the calls: later lines (a tool_result) mutate the live call objects.
    const snap = calls.map((c) => ({ ...c }))
    const open = [...snap].reverse().find((c) => c.ok === undefined)
    const last = open ?? snap.at(-1)
    const nowDoing = last ? { name: last.name, kind: last.kind, summary: last.summary, ts: last.ts } : undefined
    return { calls: snap, tokens, cost, errors, models, messages, firstModel, firstTs, lastTs, meta: out, nowDoing }
  }
  return { feed, result }
}

const TURN_TEXT = 20_000
const CHIP_TEXT = 4_000

function chipInput(input) {
  if (!input || typeof input !== "object") return input
  const o = {}
  for (const [k, v] of Object.entries(input)) o[k] = typeof v === "string" ? clip(v, CHIP_TEXT) : v
  return o
}

/** The plain text of a message's content: a string, or its text blocks joined. */
function textBlocks(c) {
  if (typeof c === "string") return c
  return Array.isArray(c) ? c.filter((b) => b?.type === "text" && typeof b.text === "string").map((b) => b.text).join("\n\n") : ""
}

/**
 * A transcript as chat turns, in file order: { i, role: "user"|"assistant", ts, text, tools[] }. One
 * assistant turn per message id (Claude Code writes a line per content block); tool results land on the
 * tool chip they answer (ok/error, result, duration), never as turns of their own. Meta lines, system
 * reminders and bad lines are skipped.
 */
export function parseTurns(text) {
  const acc = turnsAcc()
  for (const e of lines(text)) acc.feed(e)
  return acc.result()
}

/** parseTurns as an accumulator: feed(entry) per parsed line, result() for the turns so far. */
export function turnsAcc() {
  const turns = []
  const byMsg = new Map()
  const byUse = new Map()
  function feed(e) {
    const m = e.message && typeof e.message === "object" ? e.message : null
    if (!m || e.isMeta) return
    const ts = str(e.timestamp)
    if (e.type === "assistant") {
      const key = str(m.id)
      let turn = key ? byMsg.get(key) : null
      if (!turn) {
        turn = { i: turns.length, role: "assistant", ts, text: "", tools: [] }
        turns.push(turn)
        if (key) byMsg.set(key, turn)
      }
      for (const b of Array.isArray(m.content) ? m.content : typeof m.content === "string" ? [{ type: "text", text: m.content }] : []) {
        if (b?.type === "text" && typeof b.text === "string" && b.text.trim()) turn.text = clip(turn.text ? `${turn.text}\n\n${b.text}` : b.text, TURN_TEXT)
        else if (b?.type === "tool_use" && typeof b.name === "string") {
          const c = classify(b.name, b.input)
          const chip = { id: str(b.id) ?? `${turn.i}:${turn.tools.length}`, name: c.name, kind: c.kind, summary: summarize(b.name, b.input) }
          if (c.server) chip.server = c.server
          if (b.input !== undefined) chip.input = chipInput(b.input)
          turn.tools.push(chip)
          if (str(b.id)) byUse.set(b.id, { chip, at: ts })
        }
      }
    } else if (e.type === "user") {
      const blocks = Array.isArray(m.content) ? m.content : []
      for (const b of blocks) {
        if (b?.type !== "tool_result") continue
        const hit = byUse.get(b.tool_use_id)
        if (!hit) continue
        const body = clip(resultText(b.content).trim(), CHIP_TEXT)
        hit.chip.ok = b.is_error !== true
        if (b.is_error === true) hit.chip.error = body || "error"
        else if (body) hit.chip.result = body
        const d = Date.parse(ts ?? "") - Date.parse(hit.at ?? "")
        if (Number.isFinite(d) && d >= 0) hit.chip.durationMs = d
      }
      const said = textBlocks(m.content).trim()
      if (said && !said.startsWith("<system-reminder>")) turns.push({ i: turns.length, role: "user", ts, text: clip(said, TURN_TEXT), tools: [] })
    }
  }
  // An assistant message that was only thinking (no text, no tools) is not a turn; renumber after dropping.
  // Tool chips are copied: a later tool_result mutates the live chip.
  const result = () => turns.filter((t) => t.text || t.tools.length).map((t, i) => ({ ...t, i, tools: t.tools.map((c) => ({ ...c })) }))
  return { feed, result }
}
