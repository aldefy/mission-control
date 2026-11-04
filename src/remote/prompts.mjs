// Pending prompts and decisions (spec FR-11–FR-14, contract C14–C17, C20, C21).
// A hook holding a request writes remote/pending/<promptId>.json; the listener writes the decision once,
// create-exclusive, as remote/pending/<promptId>.decision.json. Sync and node: built-ins only: the hook
// loads this module.
import { createHash, randomUUID } from "node:crypto"
import { readdirSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { CLEARS, KEYED_CLEARS, hookLogPath, parseHookLines } from "../hooks.mjs"
import { isPidAlive, readJson, removeFile, writeJsonAtomic, writeJsonExclusive } from "./state.mjs"

const PROMPT_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
export const isPromptId = (s) => typeof s === "string" && PROMPT_ID.test(s)
export const newPromptId = () => randomUUID()

export const pendingDir = (remoteDir) => join(remoteDir, "pending")
const pendingPath = (remoteDir, id) => join(pendingDir(remoteDir), `${id}.json`)
const decisionPath = (remoteDir, id) => join(pendingDir(remoteDir), `${id}.decision.json`)

/** Canonical form of the questions for the bind hash: question text and option labels, in order. */
const canonQuestions = (qs) => (Array.isArray(qs) ? qs.map((q) => [String(q?.question ?? ""), (Array.isArray(q?.options) ? q.options : []).map((o) => String(o?.label ?? ""))]) : [])

/**
 * The binding hash (FR-13): SHA-256 of the prompt id, tool, target and, for an ask, the canonical JSON of
 * its questions and option labels. An answer must carry the bind it displayed.
 */
export function bindHash({ promptId, tool, target, kind, questions }) {
  const parts = [String(promptId), String(tool ?? ""), String(target ?? ""), kind === "ask" ? canonQuestions(questions) : null]
  return createHash("sha256").update(JSON.stringify(parts)).digest("hex")
}

const str = (v, max) => (typeof v === "string" ? v.slice(0, max) : "")

/**
 * AskUserQuestion questions as the hook stores and the phone shows them (C15):
 * [{question, header, multiSelect, options:[{label, description}]}], bounded in count and size.
 */
export function sanitizeQuestions(raw) {
  if (!Array.isArray(raw)) return []
  return raw.slice(0, 8).map((q) => ({
    question: str(q?.question, 1000),
    header: str(q?.header, 200),
    multiSelect: q?.multiSelect === true,
    options: (Array.isArray(q?.options) ? q.options : []).slice(0, 12).map((o) => ({ label: str(o?.label, 300), description: str(o?.description, 1000) })),
  }))
}

/** An ask the phone may answer: at least one question, none multiSelect, each with options and a text. */
export function isAnswerableAsk(questions) {
  if (!Array.isArray(questions) || !questions.length) return false
  const texts = new Set()
  for (const q of questions) {
    if (!q || q.multiSelect !== false || !q.question || !Array.isArray(q.options) || !q.options.length) return false
    if (texts.has(q.question)) return false // answers are keyed by question text
    texts.add(q.question)
    // Labels are stored cut to 300 characters; two that become equal could not be told apart.
    if (new Set(q.options.map((o) => o?.label)).size !== q.options.length) return false
  }
  return true
}

/**
 * An answer set for an ask (C16): a plain object with exactly one key per question text, each value one of
 * that question's listed option labels. No multiSelect question, no free text, no extra keys.
 */
export function validateAnswers(questions, answers) {
  if (!isAnswerableAsk(questions)) return false
  if (!answers || typeof answers !== "object" || Array.isArray(answers)) return false
  const keys = Object.keys(answers)
  if (keys.length !== questions.length) return false
  for (const q of questions) {
    if (!Object.hasOwn(answers, q.question)) return false
    const v = answers[q.question]
    if (typeof v !== "string" || !q.options.some((o) => o.label === v)) return false
  }
  return true
}

/** The shape check of an answer body's decision (400 otherwise): "allow", "deny" or {answers:{...strings}}. */
export function isDecisionShape(d) {
  if (d === "allow" || d === "deny") return true
  if (!d || typeof d !== "object" || Array.isArray(d) || Object.keys(d).length !== 1) return false
  const a = d.answers
  return !!a && typeof a === "object" && !Array.isArray(a) && Object.values(a).every((v) => typeof v === "string")
}

/** Write the hook's pending prompt (FR-11). `p` has every PendingFile field except bind, which is computed. */
export function writePending(remoteDir, p) {
  const full = { ...p, bind: bindHash(p) }
  writeJsonAtomic(pendingPath(remoteDir, p.promptId), full)
  return full
}

/** Remove a prompt's pending and decision files (the hook does this on every exit). */
export function removePending(remoteDir, promptId) {
  if (!isPromptId(promptId)) return
  removeFile(pendingPath(remoteDir, promptId))
  removeFile(decisionPath(remoteDir, promptId))
}

export const readPending = (remoteDir, promptId) => (isPromptId(promptId) ? valid(readJson(pendingPath(remoteDir, promptId))) : null)
export const readDecision = (remoteDir, promptId) => (isPromptId(promptId) ? readJson(decisionPath(remoteDir, promptId)) : null)

function valid(p) {
  if (!p || typeof p !== "object" || !isPromptId(p.promptId)) return null
  if ((p.harness !== "claude-code" && p.harness !== "codex") || (p.kind !== "permission" && p.kind !== "ask")) return null
  if (typeof p.sessionId !== "string" || typeof p.bind !== "string" || !Number.isFinite(Date.parse(p.askedAt))) return null
  return p
}

/**
 * Whether the session's hook log shows a clearing event after the prompt was asked (outcome B): an event
 * that clears the desktop card (PostToolUse, PermissionDenied, UserPromptSubmit, Stop, RemoteAnswered,
 * ...) with a timestamp after askedAt. A keyed tool event for another call id does not count.
 */
export function clearedSince({ hooksDir, pending }) {
  const path = hooksDir ? hookLogPath(hooksDir, pending.harness, pending.sessionId) : null
  if (!path) return false
  let text
  try { text = readFileSync(path, "utf8") } catch { return false }
  const asked = Date.parse(pending.askedAt)
  for (const e of parseHookLines(text)) {
    if (!CLEARS.has(e.event) || !(Date.parse(e.ts) > asked)) continue
    const id = typeof e.callId === "string" && e.callId ? e.callId : ""
    if (id && KEYED_CLEARS.has(e.event) && pending.callId && id !== pending.callId) continue
    return true
  }
  return false
}

/** Every pending file as parsed (unfiltered), skipping decisions and temp files. */
function readAll(remoteDir) {
  let names
  try { names = readdirSync(pendingDir(remoteDir)) } catch { return [] }
  const out = []
  for (const n of names) {
    if (!n.endsWith(".json") || n.endsWith(".decision.json")) continue
    const p = readPending(remoteDir, n.slice(0, -5))
    if (p) out.push(p)
  }
  return out
}

/**
 * Prompts a phone may still answer (FR-11): live hook pid, no decision yet, not cleared in the session
 * log after askedAt. A dead pid's files are deleted (a hook killed with SIGKILL leaves them behind).
 */
export function listPending({ remoteDir, hooksDir, isAlive = isPidAlive }) {
  const out = []
  for (const p of readAll(remoteDir)) {
    if (!isAlive(p.pid)) { removePending(remoteDir, p.promptId); continue }
    if (readDecision(remoteDir, p.promptId)) continue
    if (clearedSince({ hooksDir, pending: p })) continue
    out.push(p)
  }
  return out.sort((a, b) => String(a.askedAt).localeCompare(String(b.askedAt)))
}

/** Same session (and, for a keyed prompt, same call id). */
const samePlace = (a, b) => a.harness === b.harness && a.sessionId === b.sessionId && (a.callId ?? "") === (b.callId ?? "")

/**
 * Tell hooks whose prompt was answered in the terminal to give up (outcome B): an `abandon` decision for
 * each live pending prompt with a clearing event after askedAt. Returns how many were abandoned.
 */
export function abandonAnswered({ remoteDir, hooksDir, now = Date.now(), isAlive = isPidAlive }) {
  let n = 0
  for (const p of readAll(remoteDir)) {
    if (!isAlive(p.pid) || readDecision(remoteDir, p.promptId)) continue
    if (clearedSince({ hooksDir, pending: p }) && writeJsonExclusive(decisionPath(remoteDir, p.promptId), { decision: "abandon", ts: new Date(now).toISOString() })) n++
  }
  return n
}

/** Abandon every undecided pending prompt (remote turned off, C40). Returns how many. */
export function abandonAll({ remoteDir, now = Date.now() }) {
  let n = 0
  for (const p of readAll(remoteDir)) {
    if (writeJsonExclusive(decisionPath(remoteDir, p.promptId), { decision: "abandon", ts: new Date(now).toISOString() })) n++
  }
  return n
}

/** The hook's side of a give-up: claim the decision slot with abandon. false when a decision got there first. */
export function claimAbandon({ remoteDir, promptId, now = Date.now() }) {
  return writeJsonExclusive(decisionPath(remoteDir, promptId), { decision: "abandon", ts: new Date(now).toISOString() })
}

/**
 * Accept a phone's decision for a pending prompt (FR-14). Returns
 *   { ok: true, pending }              the decision was written (exactly once across concurrent calls);
 *   { error }                           a malformed decision for this prompt's kind (400);
 *   { reason: changed|answered|terminal|gone }  a refusal (409).
 * `known` (optional) maps prompt ids the listener has shown to {harness, sessionId, callId}: an id whose
 * prompt is gone while its session now waits on a different prompt is `changed`, not `gone`.
 */
export function decide({ remoteDir, hooksDir, promptId, bind, decision, device, now = Date.now(), isAlive = isPidAlive, known }) {
  if (!isDecisionShape(decision)) return { error: "decision must be \"allow\", \"deny\" or {answers}" }
  const p = readPending(remoteDir, promptId)
  if (!p || !isAlive(p.pid)) {
    const was = isPromptId(promptId) ? known?.get(promptId) : null
    if (was && listPending({ remoteDir, hooksDir, isAlive }).some((x) => x.promptId !== promptId && samePlace(x, was))) return { reason: "changed" }
    return { reason: "gone" }
  }
  if (typeof bind !== "string" || bind !== p.bind) return { reason: "changed" }
  // The phone never showed the whole action: only the terminal may answer it.
  if (p.computerOnly === true) return { error: "this prompt can only be answered at the computer" }
  // Replaced: the same session (same call) now waits on a newer prompt.
  if (readAll(remoteDir).some((x) => x.promptId !== p.promptId && samePlace(x, p) && x.askedAt > p.askedAt && isAlive(x.pid))) return { reason: "changed" }
  const prior = readDecision(remoteDir, promptId)
  if (prior) return { reason: prior.decision === "abandon" ? (clearedSince({ hooksDir, pending: p }) ? "terminal" : "gone") : "answered" }
  if (clearedSince({ hooksDir, pending: p })) {
    writeJsonExclusive(decisionPath(remoteDir, promptId), { decision: "abandon", ts: new Date(now).toISOString() })
    return { reason: "terminal" }
  }
  if (p.kind === "permission" && decision !== "allow" && decision !== "deny") return { error: "a permission prompt takes \"allow\" or \"deny\"" }
  if (p.kind === "ask") {
    if (typeof decision !== "object") return { error: "a question takes {answers}" }
    if (!validateAnswers(p.questions, decision.answers)) return { error: "answers must pick exactly one listed option per question" }
  }
  const won = writeJsonExclusive(decisionPath(remoteDir, promptId), { decision, device: String(device ?? ""), ts: new Date(now).toISOString() })
  if (!won) {
    const d = readDecision(remoteDir, promptId)
    return { reason: d?.decision === "abandon" ? (clearedSince({ hooksDir, pending: p }) ? "terminal" : "gone") : "answered" }
  }
  return { ok: true, pending: p }
}

const HARNESS_TITLE = { "claude-code": "Claude Code session", codex: "Codex session" }

/**
 * The phone's prompt list (FR-12, C14, C15): one entry per desktop Needs you entry, joined to a live
 * pending prompt by harness and sessionId (and callId when both have one). A joined entry is answerable
 * and shows the pending prompt's own tool and target, which is what its bind covers. A pending prompt
 * with no desktop entry yet gets an entry of its own (source = harness, id = sessionId). Entries with no
 * pending prompt (run formats, Codex option prompts, subagents, pre-v2.3 hooks) are read-only.
 */
export function joinEntries(needsYou, pendings) {
  const left = [...pendings].sort((a, b) => String(b.askedAt).localeCompare(String(a.askedAt))) // newest first
  const take = (pred) => {
    const k = left.findIndex(pred)
    return k < 0 ? null : left.splice(k, 1)[0]
  }
  const out = []
  for (const e of needsYou ?? []) {
    const sid = e.sessionId ?? e.id
    const p = take((x) => x.harness === e.harness && x.sessionId === sid && (!e.callId || !x.callId || x.callId === e.callId))
    out.push(entryOf(e, p))
  }
  const seen = new Set(out.map((e) => `${e.source}\u0000${e.id}`))
  for (const p of left) {
    const key = `${p.harness}\u0000${p.sessionId}`
    if (seen.has(key)) continue // an older sibling of a prompt already listed: shown once that one is answered
    seen.add(key)
    out.push(entryOf({ source: p.harness, id: p.sessionId, title: HARNESS_TITLE[p.harness] ?? p.sessionId, lane: "main", since: p.askedAt }, p))
  }
  // What the phone can answer first, then read-only entries; newest first within each.
  const t = (e) => Date.parse(e.askedAt ?? e.since ?? "") || 0
  return out.sort((a, b) => Number(b.answerable) - Number(a.answerable) || t(b) - t(a))
}

function entryOf(e, p) {
  const answerable = !!p && ((p.kind === "permission" && p.computerOnly !== true) || (p.kind === "ask" && isAnswerableAsk(p.questions)))
  const project = typeof e.project === "string" ? e.project : e.project?.name
  const base = {
    source: String(e.source), id: String(e.id), title: String(e.title ?? ""),
    ...(project ? { project: String(project) } : {}),
    lane: String(e.lane ?? ""),
    tool: String((answerable ? p.tool : e.tool) ?? ""),
    target: String((answerable ? p.target : e.target) ?? "").slice(0, 120),
    // C10: the same type and value as the desktop Needs you entry's since (null stays null).
    since: "since" in e ? e.since : (p?.askedAt ?? null),
  }
  if (!answerable) return { ...base, answerable: false }
  if (p.kind === "permission") return { ...base, answerable: true, promptId: p.promptId, bind: p.bind, kind: "permission" }
  const questions = p.questions.map((q) => ({ question: q.question, header: q.header, multiSelect: false, options: q.options.map((o) => ({ label: o.label, description: o.description })) }))
  return { ...base, answerable: true, promptId: p.promptId, bind: p.bind, kind: "ask", questions }
}
