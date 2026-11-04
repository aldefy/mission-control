import { appendFileSync, closeSync, mkdirSync, openSync, readFileSync, readSync, statSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"

/**
 * Claude Code hook events the dashboard listens to. PermissionRequest fires the moment a permission dialog
 * opens (a Notification of type permission_prompt only after ~6 s without typing), so it opens a wait at
 * once; the Notification stays as the fallback for older Claude Code. PostToolUse / PostToolUseFailure /
 * PermissionDenied mean the prompt was answered (in the terminal, too), so they clear it.
 */
export const EVENTS = ["Notification", "PermissionRequest", "Stop", "SubagentStop", "UserPromptSubmit", "PreToolUse", "PostToolUse", "PostToolUseFailure", "PermissionDenied"]
const SAFE_ID = /^[\w-][\w.-]*$/
/**
 * Events that end a wait. RemoteAnswered is written by a hook that applied a decision from a paired
 * phone (v2.3), so the desktop card clears the same way a terminal answer clears it.
 */
export const CLEARS = new Set(["PreToolUse", "UserPromptSubmit", "Stop", "PostToolUse", "PostToolUseFailure", "PermissionDenied", "RemoteAnswered"])
export const OPENS = new Set(["Notification", "PermissionRequest"])
// Tool events that end only the wait for their own call id (when they carry one).
export const KEYED_CLEARS = new Set(["PreToolUse", "PostToolUse", "PostToolUseFailure", "PermissionDenied", "RemoteAnswered"])
const MAX_MESSAGE = 500
const MAX_TARGET = 120

// Obvious secrets in a command line, masked before the target is cut or stored. Best effort, not a scanner.
const SECRETS = [
  [/(\bBearer\s+)[^\s'"]+/gi, "$1***"],
  [/(\b[A-Za-z_]*(?:token|key|secret|password|passwd|pwd)[A-Za-z_]*\s*[=:]\s*)("[^"]*"|'[^']*'|[^\s&'"]+)/gi, "$1***"],
  [/(^|\s)-p(?![\s-])\S+/g, "$1-p***"],
  [/\b(AKIA|ASIA)[A-Z0-9]{16}\b/g, "$1***"],
  [/\b(ghp_|gho_|ghs_|ghu_|github_pat_|xox[abposr]-|sk-)[A-Za-z0-9_-]{8,}/g, "$1***"],
]

/** A command line with obvious secrets masked: Bearer tokens, token=/key=/password= values, -p<password>, AWS and GitHub-style keys. */
export function maskSecrets(text) {
  let out = text
  for (const [re, to] of SECRETS) out = out.replace(re, to)
  return out
}

// Tools whose whole effect is their one command or path, so the phone can show all of it. Write, Edit, MCP
// tools, WebFetch, Task and the rest carry more than that (contents, URLs, arguments): those are answered at
// the computer.
const PHONE_TOOLS = new Set(["Bash", "Read", "shell", "local_shell", "exec_command"])

/**
 * Whether a permission prompt can be answered from the phone: the phone shows the entire action. Only the
 * tools above, with a command or path that fits the card on one line. A longer command would be cut and a
 * multi-line one shown with its line breaks as spaces, so the phone would approve something it never showed.
 */
export function phoneCanShow(toolName, toolInput) {
  if (!PHONE_TOOLS.has(toolName) || !toolInput || typeof toolInput !== "object") return false
  const v = [toolInput.command, toolInput.file_path, toolInput.path].find((x) => typeof x === "string" && x.trim())
  if (!v || /[\r\n\u2028\u2029]/.test(v)) return false
  return v.trim().length <= MAX_TARGET
}

/**
 * What a tool call is about, secret-safe: the first 120 characters of its command or file path, on one
 * line, with obvious secrets masked. Nothing else from tool_input is ever kept (no file contents, no edit
 * strings, no descriptions, no prompts).
 */
export function targetOf(toolInput) {
  if (!toolInput || typeof toolInput !== "object") return null
  const v = [toolInput.command, toolInput.file_path, toolInput.notebook_path, toolInput.path].find((x) => typeof x === "string" && x.trim())
  if (!v) return null
  const line = v.replace(/\s+/g, " ").trim()
  return (typeof toolInput.command === "string" && v === toolInput.command ? maskSecrets(line) : line).slice(0, MAX_TARGET)
}

/** A PermissionRequest from a subagent that no Notification confirms within this long was auto-denied (no prompt shown). */
export const UNCONFIRMED_MS = 10_000

export const defaultHooksDir = (home = homedir()) => join(home, ".mission-control", "hooks")

/**
 * Append one hook event to <hooksDir>/<session_id>.jsonl (dir 0700, file 0600). Synchronous and local,
 * and never throws: it runs inside the user's Claude Code session. True when a line was written.
 */
export function recordHook({ raw, event, hooksDir = defaultHooksDir(), now = () => new Date() }) {
  try {
    const input = JSON.parse(raw)
    if (!input || typeof input !== "object") return false
    const sessionId = input.session_id
    const name = typeof input.hook_event_name === "string" ? input.hook_event_name : event
    if (typeof sessionId !== "string" || !SAFE_ID.test(sessionId) || !EVENTS.includes(name)) return false
    const line = { event: name, sessionId, ts: now().toISOString() }
    if (typeof input.message === "string") line.message = input.message.slice(0, MAX_MESSAGE)
    if (typeof input.tool_name === "string") line.tool = input.tool_name
    if (typeof input.notification_type === "string") line.kind = input.notification_type.slice(0, 40)
    // A subagent's event: its PermissionRequest may never show a prompt (background, non-interactive).
    if (typeof input.agent_id === "string" && SAFE_ID.test(input.agent_id) && input.agent_id.length <= 128) line.agentId = input.agent_id
    if (name === "PreToolUse" || name === "PermissionRequest") {
      const target = targetOf(input.tool_input)
      if (target) line.target = target
    }
    if (name === "PermissionRequest" && !line.message) line.message = `Claude needs your permission to use ${line.tool ?? "a tool"}`
    mkdirSync(hooksDir, { recursive: true, mode: 0o700 })
    appendFileSync(join(hooksDir, `${sessionId}.jsonl`), JSON.stringify(line) + "\n", { mode: 0o600 })
    return true
  } catch { return false }
}

/** Parse hook log text (or an array of lines) into events, skipping blank or half-written lines. */
export function parseHookLines(lines) {
  const list = typeof lines === "string" ? lines.split("\n") : lines
  const out = []
  for (const l of list) {
    if (typeof l === "object" && l) { out.push(l); continue }
    try { const j = JSON.parse(l); if (j && typeof j === "object") out.push(j) } catch { /* skip */ }
  }
  return out
}

/** Claude Code's idle reminder, fired about a minute after a turn ends: the session is ready, not blocked. */
export const IDLE_MESSAGE = /waiting for your input/i

/**
 * Waiting = an open Notification or PermissionRequest with no clearing event after it (log order):
 * PreToolUse, PostToolUse(Failure), PermissionDenied, UserPromptSubmit or Stop. A Notification that
 * follows an open PermissionRequest is the same prompt (Claude's ~6 s reminder), not a new one: `since`
 * stays. An idle reminder (notification_type idle_prompt, or its message) is `ready: true` with
 * `waiting: false`; so is a Codex turn that ended (codexEvent Stop), with `turnEnd: true`.
 * The prompt's tool and target come from its own line, else from the PreToolUse just before it.
 *
 * A wait that carries a `callId` (Codex PermissionRequest for one tool call) is a wait of its own: only a
 * tool event for the same call id, a tool event with no id, a new prompt or Stop clears it, so a sibling
 * tool running in parallel never clears it. An unkeyed wait replaces every open wait (Claude's rule). The
 * oldest still-open keyed wait is reported (it is what blocks the session), else the newest.
 * A subagent's PermissionRequest (agentId set) is `tentative` until a Notification follows it: the reader
 * drops it after UNCONFIRMED_MS (it was auto-denied in a session that cannot prompt).
 * { waiting, ready?, turnEnd?, message?, since?, tool?, target?, callId?, tentative? }. Takes parsed events or raw lines.
 */
export function waitingFromHooks(lines) {
  const events = parseHookLines(lines)
  const open = new Map() // callId ("" for unkeyed) -> open state, in arrival order
  let pre = null
  for (const e of events) {
    const ev = e.event
    const id = typeof e.callId === "string" && e.callId ? e.callId : ""
    if (OPENS.has(ev)) {
      const msg = typeof e.message === "string" ? e.message : undefined
      const idle = ev === "Notification" && (e.kind === "idle_prompt" || (msg !== undefined && IDLE_MESSAGE.test(msg)))
      if (idle) { open.clear(); open.set("", { ready: true, message: msg, since: e.ts }); continue }
      const prev = open.get(id)
      if (ev === "Notification" && prev?.waiting && prev.from === "PermissionRequest") { prev.message ??= msg; prev.tentative = false; continue }
      const tool = typeof e.tool === "string" ? e.tool : pre?.tool
      const target = typeof e.target === "string" ? e.target : typeof e.tool === "string" && e.tool !== pre?.tool ? undefined : pre?.target
      if (!id) open.clear()
      open.delete(id)
      // A subagent's PermissionRequest: background subagents in non-interactive mode cannot show a prompt, and
      // Claude Code then denies the call without a PermissionDenied hook (that fires only in auto mode). A
      // shown prompt is followed by the ~6 s permission Notification, which confirms it; see UNCONFIRMED_MS.
      const tentative = ev === "PermissionRequest" && typeof e.agentId === "string" && e.agentId !== ""
      open.set(id, { waiting: true, from: ev, message: msg, since: e.ts, tool, target, callId: id || undefined, tentative })
    } else if (CLEARS.has(ev)) {
      if (id && KEYED_CLEARS.has(ev)) { open.delete(id); open.delete("") } else open.clear()
      if (ev === "Stop" && e.codexEvent === "Stop") open.set("", { ready: true, turnEnd: true, since: e.ts })
      pre = ev === "PreToolUse" && e.codexEvent !== "PostToolUse" ? e : null
    }
  }
  const all = [...open.values()]
  const newest = all.at(-1)
  if (!newest) return { waiting: false }
  const oldest = all[0]
  const shown = oldest !== newest && oldest.callId ? oldest : newest
  const out = shown.ready ? { waiting: false, ready: true } : { waiting: true }
  if (shown.turnEnd) out.turnEnd = true
  if (typeof shown.message === "string") out.message = shown.message
  if (typeof shown.since === "string") out.since = shown.since
  if (typeof shown.tool === "string") out.tool = shown.tool
  if (typeof shown.target === "string") out.target = shown.target
  if (typeof shown.callId === "string") out.callId = shown.callId
  if (shown.tentative) out.tentative = true
  return out
}

/** Read a session's hook state from disk; { waiting: false } when there is no log. */
export function readWaiting(hooksDir, sessionId) {
  try { return waitingFromHooks(readFileSync(join(hooksDir, `${sessionId}.jsonl`), "utf8")) } catch { return { waiting: false } }
}

const HOOK_TAIL = 64 * 1024
const CACHED_LOGS = 8192

/**
 * readWaiting with a per-file cache keyed by size+mtime: an unchanged log is not read again. A log over
 * `tailBytes` is read from its tail only; the tail decides when it holds a Notification or a clearing
 * event (the cut first line is skipped), else the whole log is read. `onRead(path, { bytes })` is for tests.
 */
export function createWaitingReader({ tailBytes = HOOK_TAIL, onRead } = {}) {
  const cache = new Map() // path -> { key, value }
  function read(path, size) {
    const fd = openSync(path, "r")
    try {
      const n = Math.min(size, tailBytes)
      const buf = Buffer.alloc(n)
      const got = readSync(fd, buf, 0, n, size - n)
      onRead?.(path, { bytes: got })
      const text = buf.toString("utf8", 0, got)
      if (n === size) return waitingFromHooks(text)
      const events = parseHookLines(text.slice(text.indexOf("\n") + 1))
      // The tail decides only when it holds an event that resets every wait; a keyed event alone could
      // leave an older open wait before the tail, so that needs the whole log.
      if (events.some((e) => (OPENS.has(e.event) || CLEARS.has(e.event)) && !e.callId)) return waitingFromHooks(events)
    } finally { closeSync(fd) }
    onRead?.(path, { bytes: size })
    return waitingFromHooks(readFileSync(path, "utf8"))
  }
  return function readWaitingCached(hooksDir, sessionId) {
    const path = join(hooksDir, `${sessionId}.jsonl`)
    let st
    try { st = statSync(path) } catch { cache.delete(path); return { waiting: false } }
    const key = `${st.ino}|${st.size}|${st.mtimeMs}`
    const hit = cache.get(path)
    if (hit && hit.key === key) return hit.value
    let value
    try { value = read(path, st.size) } catch { value = { waiting: false } }
    if (cache.size >= CACHED_LOGS) cache.delete(cache.keys().next().value)
    cache.set(path, { key, value })
    return value
  }
}

/** Hook events that may hold the request for a remote answer (v2.3): they get a longer timeout. */
const WAITING_CLAUDE = new Set(["PermissionRequest", "PreToolUse"])
const DEFAULT_WAIT = 120
const waitTimeout = (waitSeconds) => (Number.isInteger(waitSeconds) && waitSeconds > 0 ? waitSeconds : DEFAULT_WAIT) + 15

/**
 * The settings.json block to merge by hand; `node` and the script are absolute. PermissionRequest and
 * PreToolUse (AskUserQuestion) may wait for a paired phone, so their timeout is `waitSeconds + 15`; the
 * hook itself gives up after `waitSeconds` and prints nothing, so the terminal prompt takes over. No
 * `onFailure` is ever set: a failed or timed-out hook must fall through to the terminal, never deny.
 */
export function settingsBlock({ node = process.execPath, script, waitSeconds = DEFAULT_WAIT }) {
  const q = (s) => `'${String(s).replace(/'/g, `'\\''`)}'`
  const hooks = {}
  for (const e of EVENTS) {
    const h = { type: "command", command: `${q(node)} ${q(script)} hook ${e}` }
    if (WAITING_CLAUDE.has(e)) h.timeout = waitTimeout(waitSeconds)
    hooks[e] = [{ hooks: [h] }]
  }
  return { hooks }
}

/**
 * Codex CLI hook events (hooks.json / [hooks] in ~/.codex/config.toml) and the dashboard event each is
 * recorded as, so one waiting rule serves both harnesses: PermissionRequest (Codex is about to ask for
 * approval) opens a wait like a Claude Notification; a tool starting or finishing, a new prompt, the turn
 * ending or an interrupt clears it.
 */
export const CODEX_EVENTS = {
  PermissionRequest: "Notification",
  PreToolUse: "PreToolUse",
  PostToolUse: "PreToolUse",
  UserPromptSubmit: "UserPromptSubmit",
  Stop: "Stop",
  Interrupt: "Stop",
  SubagentStop: "SubagentStop",
}

/**
 * Append one Codex hook event to <hooksDir>/codex/<session_id>.jsonl in the same line format as Claude's
 * (`event` is the mapped name, `codexEvent` the original). Never throws; true when a line was written.
 */
export function recordCodexHook({ raw, hooksDir = defaultHooksDir(), now = () => new Date() }) {
  try {
    const input = JSON.parse(raw)
    if (!input || typeof input !== "object") return false
    const sessionId = input.session_id
    const name = input.hook_event_name
    if (typeof sessionId !== "string" || !SAFE_ID.test(sessionId) || typeof name !== "string" || !Object.hasOwn(CODEX_EVENTS, name)) return false
    const line = { event: CODEX_EVENTS[name], codexEvent: name, sessionId, ts: now().toISOString() }
    if (typeof input.tool_name === "string") line.tool = input.tool_name
    if (name === "PermissionRequest" || name === "PreToolUse") {
      const target = targetOf(input.tool_input)
      if (target) line.target = target
    }
    // The tool call this event is about, so parallel tools keep separate waits (see waitingFromHooks).
    const callId = [input.tool_use_id, input.call_id, input.tool_call_id].find((v) => typeof v === "string" && SAFE_ID.test(v) && v.length <= 128)
    if (callId) line.callId = callId
    if (name === "PermissionRequest") {
      // The masked target only: tool_input.description is free text written by the model and may quote anything.
      const tool = typeof input.tool_name === "string" ? input.tool_name : "a tool"
      line.message = `Codex needs your approval to use ${tool}${line.target ? `: ${line.target}` : ""}`.slice(0, MAX_MESSAGE)
    }
    const dir = join(hooksDir, "codex")
    mkdirSync(dir, { recursive: true, mode: 0o700 })
    appendFileSync(join(dir, `${sessionId}.jsonl`), JSON.stringify(line) + "\n", { mode: 0o600 })
    return true
  } catch { return false }
}

/**
 * The hooks.json block for Codex (merge into ~/.codex/hooks.json by hand); `node` and the script are
 * absolute. PermissionRequest may wait for a paired phone (`waitSeconds + 15`); the rest stay at 10 s.
 */
export function codexHooksBlock({ node = process.execPath, script, waitSeconds = DEFAULT_WAIT }) {
  const q = (s) => `'${String(s).replace(/'/g, `'\\''`)}'`
  const hooks = {}
  for (const e of Object.keys(CODEX_EVENTS)) {
    const timeout = e === "PermissionRequest" ? waitTimeout(waitSeconds) : 10
    hooks[e] = [{ hooks: [{ type: "command", command: `${q(node)} ${q(script)} hook codex`, timeout }] }]
  }
  return { hooks }
}

/** Where a session's hook log lives: <hooksDir>/<id>.jsonl (Claude Code) or <hooksDir>/codex/<id>.jsonl. */
export function hookLogPath(hooksDir, harness, sessionId) {
  if (typeof sessionId !== "string" || !SAFE_ID.test(sessionId)) return null
  return harness === "codex" ? join(hooksDir, "codex", `${sessionId}.jsonl`) : join(hooksDir, `${sessionId}.jsonl`)
}

function appendLine(hooksDir, harness, line) {
  const path = hookLogPath(hooksDir, harness, line.sessionId)
  if (!path) return false
  mkdirSync(harness === "codex" ? join(hooksDir, "codex") : hooksDir, { recursive: true, mode: 0o700 })
  appendFileSync(path, JSON.stringify(line) + "\n", { mode: 0o600 })
  return true
}

/**
 * A prompt was answered from a paired phone: one clearing line, keyed by `callId` when the prompt had
 * one (so a parallel Codex call keeps its own wait). Never throws; true when written.
 */
export function recordRemoteAnswered({ hooksDir = defaultHooksDir(), harness, sessionId, callId, now = () => new Date() }) {
  try {
    const line = { event: "RemoteAnswered", sessionId, ts: now().toISOString() }
    if (harness === "codex") line.codexEvent = "RemoteAnswered"
    if (typeof callId === "string" && SAFE_ID.test(callId) && callId.length <= 128) line.callId = callId
    return appendLine(hooksDir, harness, line)
  } catch { return false }
}

/**
 * An AskUserQuestion the hook holds for a phone answer: an opening Notification (kind ask_user_question,
 * tool AskUserQuestion), so the desktop Needs you card shows the same prompt the phone shows. The
 * question text is model-written and never goes in the log. Never throws; true when written.
 */
export function recordAskOpen({ hooksDir = defaultHooksDir(), sessionId, now = () => new Date() }) {
  try {
    return appendLine(hooksDir, "claude-code", { event: "Notification", sessionId, ts: now().toISOString(), message: "Claude has a question for you", tool: "AskUserQuestion", kind: "ask_user_question" })
  } catch { return false }
}

/** The open prompt as a lane shows it: { since?, tool?, target?, callId? } (only the keys that are known). */
export function askOf(w) {
  const out = {}
  for (const k of ["since", "tool", "target", "callId"]) if (typeof w?.[k] === "string") out[k] = w[k]
  return out
}

/** Summary fields for a ready session (done, waiting for your next prompt): { ready, readySince? } or {}. */
export function readyOf(w) {
  if (!w?.ready) return {}
  return typeof w.since === "string" ? { ready: true, readySince: w.since } : { ready: true }
}
