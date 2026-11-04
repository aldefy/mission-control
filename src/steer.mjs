import { mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs"
import { randomUUID } from "node:crypto"
import { homedir } from "node:os"
import { join } from "node:path"

/**
 * Steering a running session: messages queued for a Claude Code or Codex session, delivered by that
 * session's Stop hook when its current turn ends. The hook answers {"decision":"block","reason": <message>},
 * which both harnesses take as the next prompt, so the agent carries on with it instead of stopping.
 *
 * One file per message: <steerDir>/<harness>/<sessionId>/<at>-<id>.json (dirs 0700, files 0600). The hook
 * claims the oldest by renaming it, so two Stop hooks never deliver the same message. node: built-ins only:
 * it runs inside the hook.
 */
export const HARNESSES = new Set(["claude-code", "codex"])
export const MAX_TEXT = 4000
const SAFE_ID = /^[\w-][\w.-]{0,127}$/
const FILE = /^(\d{13})-([\w-]{1,64})\.json$/

export const defaultSteerDir = (home = homedir()) => join(home, ".mission-control", "steer")

function dirOf(steerDir, harness, sessionId) {
  if (!steerDir || !HARNESSES.has(harness) || typeof sessionId !== "string" || !SAFE_ID.test(sessionId)) return null
  return join(steerDir, harness, sessionId)
}

/** Queue a message. Returns the queued entry, or { error }. */
export function enqueue(steerDir, { harness, sessionId, text, from = "dashboard", now = Date.now() }) {
  const dir = dirOf(steerDir, harness, sessionId)
  if (!dir) return { error: "not allowed" }
  const body = typeof text === "string" ? text.trim() : ""
  if (!body) return { error: "write a message" }
  if (body.length > MAX_TEXT) return { error: `keep it under ${MAX_TEXT} characters` }
  const entry = { id: randomUUID(), text: body, from: String(from).slice(0, 32), at: new Date(now).toISOString() }
  mkdirSync(dir, { recursive: true, mode: 0o700 })
  const tmp = join(dir, `.${entry.id}.tmp`)
  writeFileSync(tmp, JSON.stringify(entry), { mode: 0o600 })
  renameSync(tmp, join(dir, `${String(now).padStart(13, "0")}-${entry.id}.json`))
  return entry
}

function files(dir) {
  try { return readdirSync(dir).filter((f) => FILE.test(f)).sort() } catch { return [] }
}

function readEntry(path) {
  try {
    const e = JSON.parse(readFileSync(path, "utf8"))
    return e && typeof e.text === "string" ? e : null
  } catch { return null }
}

/** The messages still waiting for this session, oldest first. */
export function listQueued(steerDir, harness, sessionId) {
  const dir = dirOf(steerDir, harness, sessionId)
  if (!dir) return []
  return files(dir).map((f) => readEntry(join(dir, f))).filter(Boolean)
}

/** Remove a waiting message by id. True when it was still waiting. */
export function cancel(steerDir, harness, sessionId, id) {
  const dir = dirOf(steerDir, harness, sessionId)
  if (!dir || typeof id !== "string") return false
  const f = files(dir).find((x) => x.match(FILE)[2] === id)
  if (!f) return false
  try { rmSync(join(dir, f)); return true } catch { return false }
}

/**
 * Claim every waiting message for the session (oldest first) and remove it: what the Stop hook delivers.
 * A message another hook claimed first is skipped. Never throws.
 */
export function claimAll(steerDir, harness, sessionId) {
  const dir = dirOf(steerDir, harness, sessionId)
  if (!dir) return []
  const out = []
  for (const f of files(dir)) {
    const claimed = join(dir, `.${f}.claimed-${process.pid}`)
    try { renameSync(join(dir, f), claimed) } catch { continue }
    const e = readEntry(claimed)
    try { rmSync(claimed) } catch { /* gone already */ }
    if (e) out.push(e)
  }
  return out
}

/** The Stop hook's stdout for the claimed messages, or "" to let the turn end as usual. */
export function stopHookOutput(messages) {
  if (!messages.length) return ""
  const body = messages.length === 1
    ? messages[0].text
    : messages.map((m, i) => `${i + 1}. ${m.text}`).join("\n")
  const reason = `Message from the user, sent through Mission Control while you were working. Treat it as their next prompt:\n\n${body}`
  return JSON.stringify({ decision: "block", reason })
}
