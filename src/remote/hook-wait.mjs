// The hook side of remote answering (spec FR-16–FR-20, contract C33). node: built-ins only, no socket:
// the hook talks to the server through files under remote/. Every way out that is not an accepted,
// still-valid decision prints nothing, so the terminal prompt handles the request as it does today.
import { phoneCanShow, recordAskOpen, recordRemoteAnswered, targetOf } from "../hooks.mjs"
import { listDevices } from "./pairing.mjs"
import { claimAbandon, clearedSince, isAnswerableAsk, newPromptId, readDecision, removePending, sanitizeQuestions, validateAnswers, writePending } from "./prompts.mjs"
import { isPidAlive, readServer } from "./state.mjs"

export const POLL_MS = 200
export const DENY_MESSAGE = "Denied from Mission Control"
const SAFE_ID = /^[\w-][\w.-]*$/

/**
 * Which kind of remote wait this hook event may hold (FR-16), or null for none:
 * - Claude Code PermissionRequest from the main agent ("permission"); a subagent's (agent_id) never waits,
 *   and plan approval (ExitPlanMode) is out of scope;
 * - Claude Code PreToolUse for AskUserQuestion ("ask"), only when every question can be answered from a
 *   phone (no multiSelect, options listed);
 * - Codex PermissionRequest ("permission").
 */
export function waitKind({ harness, input }) {
  if (!input || typeof input !== "object") return null
  const ev = input.hook_event_name
  if (harness === "codex") return ev === "PermissionRequest" ? "permission" : null
  if (typeof input.agent_id === "string" && input.agent_id) return null
  if (ev === "PermissionRequest") return input.tool_name === "ExitPlanMode" || input.tool_name === "AskUserQuestion" ? null : "permission"
  if (ev === "PreToolUse" && input.tool_name === "AskUserQuestion") return isAnswerableAsk(sanitizeQuestions(input.tool_input?.questions)) ? "ask" : null
  return null
}

/**
 * The live server's info when a hook may wait (FR-17): server.json fresh (under 6 s) with a live pid,
 * `enabled: true`, and at least one paired device. null otherwise: exit at once, print nothing.
 */
export function shouldWait({ remoteDir, now = Date.now(), isAlive = isPidAlive }) {
  const srv = readServer(remoteDir, { now, isAlive })
  if (!srv || srv.enabled !== true) return null
  return listDevices({ remoteDir }).length ? srv : null
}

/** waitSeconds from server.json, bounded to 1–600 (default 120). The server writes 10–600. */
export const waitSecondsOf = (srv) => (Number.isFinite(srv?.waitSeconds) && srv.waitSeconds > 0 ? Math.min(srv.waitSeconds, 600) : 120)

/** The pending prompt for this hook (FR-11), without bind (writePending adds it). */
export function buildPending({ harness, kind, input, now = Date.now(), pid = process.pid }) {
  const p = {
    promptId: newPromptId(), harness, sessionId: input.session_id, kind,
    tool: typeof input.tool_name === "string" ? input.tool_name : "",
    target: (kind === "permission" && targetOf(input.tool_input)) || "",
    askedAt: new Date(now).toISOString(), pid,
  }
  if (harness === "codex") {
    const callId = [input.tool_use_id, input.call_id, input.tool_call_id].find((v) => typeof v === "string" && SAFE_ID.test(v) && v.length <= 128)
    if (callId) p.callId = callId
  }
  if (kind === "ask") p.questions = sanitizeQuestions(input.tool_input?.questions)
  // Listed on the phone as "answer at the computer": it cannot show the whole action (see phoneCanShow).
  if (kind === "permission" && !phoneCanShow(p.tool, input.tool_input)) p.computerOnly = true
  return p
}

/**
 * Poll every 200 ms for a decision (FR-18). Resolves with the decision ("allow", "deny" or {answers}), or
 * null when the deadline passes, server.json goes stale or `enabled` turns false, an abandon arrives, the
 * session log clears the prompt, or the hook is orphaned. On every null path the hook claims the decision
 * slot with abandon first, so a phone tap that lands at the same moment is refused, never half-applied.
 */
export async function waitForDecision({ remoteDir, hooksDir, pending, deadline, now = () => Date.now(), sleep = (ms) => new Promise((r) => setTimeout(r, ms)), pollMs = POLL_MS, isAlive = isPidAlive, orphaned = () => process.ppid === 1 }) {
  for (;;) {
    const d = readDecision(remoteDir, pending.promptId)
    if (d) return d.decision === "abandon" ? null : d.decision
    if (now() >= deadline) break
    const srv = readServer(remoteDir, { now: now(), isAlive })
    if (!srv || srv.enabled !== true) break
    if (clearedSince({ hooksDir, pending })) break
    if (orphaned()) break
    await sleep(pollMs)
  }
  if (claimAbandon({ remoteDir, promptId: pending.promptId, now: now() })) return null
  const d = readDecision(remoteDir, pending.promptId)
  return d && d.decision !== "abandon" ? d.decision : null
}

/** Claude Code PermissionRequest output: allow once, or deny with the Mission Control message. Never updatedPermissions. */
export function claudePermissionOutput(decision) {
  const d = decision === "allow" ? { behavior: "allow" } : { behavior: "deny", message: DENY_MESSAGE }
  return { hookSpecificOutput: { hookEventName: "PermissionRequest", decision: d } }
}

/** Claude Code PreToolUse(AskUserQuestion) output: allow, with the original input plus the chosen answers. */
export function claudeAskOutput(toolInput, answers) {
  return { hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "allow", updatedInput: { ...toolInput, answers } } }
}

/** Codex PermissionRequest output: allow or deny only (updatedInput, updatedPermissions, interrupt fail closed in Codex). */
export function codexPermissionOutput(decision) {
  const d = decision === "allow" ? { behavior: "allow" } : { behavior: "deny", message: DENY_MESSAGE }
  return { hookSpecificOutput: { hookEventName: "PermissionRequest", decision: d } }
}

/**
 * The stdout text for a decision, or "" when it does not fit the prompt (checked again here, so a bad
 * decision file can never become output). Ask answers are re-keyed to the original question texts and labels.
 */
export function outputFor({ harness, pending, decision, toolInput }) {
  if (pending.kind === "permission") {
    if (pending.computerOnly || (decision !== "allow" && decision !== "deny")) return ""
    return JSON.stringify(harness === "codex" ? codexPermissionOutput(decision) : claudePermissionOutput(decision))
  }
  if (harness !== "claude-code" || !decision || typeof decision !== "object" || !validateAnswers(pending.questions, decision.answers)) return ""
  const original = Array.isArray(toolInput?.questions) ? toolInput.questions : []
  const answers = {}
  pending.questions.forEach((q, i) => {
    const text = typeof original[i]?.question === "string" ? original[i].question : q.question
    // The phone picked a stored (possibly cut) label: answer with the original label at that position.
    const chosen = decision.answers[q.question]
    const j = q.options.findIndex((o) => o.label === chosen)
    const label = original[i]?.options?.[j]?.label
    answers[text] = typeof label === "string" && label.slice(0, 300) === chosen ? label : chosen
  })
  return JSON.stringify(claudeAskOutput(toolInput, answers))
}

/**
 * Hold one hook request for a remote answer (FR-17–FR-20). Returns the text to print ("" for none). The
 * caller has already recorded the hook line. `onPending(promptId)` lets the caller remove the pending
 * file from a signal handler. Never throws.
 */
export async function holdForAnswer({ harness, input, hooksDir, remoteDir, now = () => Date.now(), sleep, pollMs, isAlive = isPidAlive, orphaned, onPending = () => {} }) {
  let pending = null
  try {
    const kind = waitKind({ harness, input })
    if (!kind || typeof input.session_id !== "string" || !SAFE_ID.test(input.session_id)) return ""
    const srv = shouldWait({ remoteDir, now: now(), isAlive })
    if (!srv) return ""
    if (kind === "ask" && !recordAskOpen({ hooksDir, sessionId: input.session_id, now: () => new Date(now()) })) return ""
    pending = writePending(remoteDir, buildPending({ harness, kind, input, now: now() }))
    onPending(pending.promptId)
    const deadline = now() + waitSecondsOf(srv) * 1000
    const decision = await waitForDecision({ remoteDir, hooksDir, pending, deadline, now, sleep, pollMs, isAlive, orphaned })
    if (decision == null) return ""
    // Outcome B guard: answered in the terminal meanwhile means no late answer reaches the session.
    if (clearedSince({ hooksDir, pending })) return ""
    const out = outputFor({ harness, pending, decision, toolInput: input.tool_input })
    if (!out) return ""
    recordRemoteAnswered({ hooksDir, harness, sessionId: pending.sessionId, callId: pending.callId, now: () => new Date(now()) })
    return out
  } catch {
    return ""
  } finally {
    if (pending) removePending(remoteDir, pending.promptId)
  }
}
