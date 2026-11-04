import { test } from "node:test"
import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import { mkdtempSync, readdirSync, statSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { cancel, claimAll, enqueue, listQueued, stopHookOutput } from "../src/steer.mjs"
import { createServer } from "../src/server.mjs"

const bin = fileURLToPath(new URL("../bin/mission-control.mjs", import.meta.url))
const tmp = (p = "mc-steer-") => mkdtempSync(join(tmpdir(), p))

test("steer: queue, list oldest first, cancel, claim once", () => {
  const dir = tmp()
  const a = enqueue(dir, { harness: "claude-code", sessionId: "s1", text: " first ", now: 1000 })
  const b = enqueue(dir, { harness: "claude-code", sessionId: "s1", text: "second", now: 2000 })
  enqueue(dir, { harness: "claude-code", sessionId: "s1", text: "third", now: 3000 })
  assert.deepEqual(listQueued(dir, "claude-code", "s1").map((m) => m.text), ["first", "second", "third"])
  assert.equal(cancel(dir, "claude-code", "s1", b.id), true)
  assert.equal(cancel(dir, "claude-code", "s1", b.id), false)
  const st = statSync(join(dir, "claude-code", "s1"))
  assert.equal(st.mode & 0o777, 0o700)
  assert.deepEqual(claimAll(dir, "claude-code", "s1").map((m) => m.id).slice(0, 1), [a.id])
  assert.deepEqual(claimAll(dir, "claude-code", "s1"), [])
  assert.deepEqual(readdirSync(join(dir, "claude-code", "s1")), [])
})

test("steer: refuses bad harnesses, ids, empty and huge text", () => {
  const dir = tmp()
  assert.ok(enqueue(dir, { harness: "x", sessionId: "s1", text: "hi" }).error)
  assert.ok(enqueue(dir, { harness: "codex", sessionId: "../etc", text: "hi" }).error)
  assert.ok(enqueue(dir, { harness: "codex", sessionId: "s1", text: "   " }).error)
  assert.ok(enqueue(dir, { harness: "codex", sessionId: "s1", text: "x".repeat(4001) }).error)
  assert.deepEqual(listQueued(dir, "codex", "../etc"), [])
})

test("steer: the Stop hook output blocks the stop with the messages as the next prompt", () => {
  assert.equal(stopHookOutput([]), "")
  const one = JSON.parse(stopHookOutput([{ text: "also cover the empty state" }]))
  assert.equal(one.decision, "block")
  assert.match(one.reason, /also cover the empty state$/)
  const two = JSON.parse(stopHookOutput([{ text: "a" }, { text: "b" }]))
  assert.match(two.reason, /1\. a\n2\. b$/)
})

const hook = (args, input, steerDir) =>
  spawnSync(process.execPath, [bin, "hook", ...args], { input, encoding: "utf8", env: { ...process.env, MISSION_CONTROL_HOOKS_DIR: tmp("mc-hooks-"), MISSION_CONTROL_HOME: tmp("mc-home-"), MISSION_CONTROL_STEER_DIR: steerDir } })

test("hook: Stop hands a queued message over once (Claude Code and Codex); other events never do", () => {
  const dir = tmp()
  enqueue(dir, { harness: "claude-code", sessionId: "s1", text: "run the tests too" })
  const pre = hook(["PreToolUse"], JSON.stringify({ session_id: "s1", hook_event_name: "PreToolUse", tool_name: "Bash" }), dir)
  assert.equal(pre.stdout, "")
  const stop = hook(["Stop"], JSON.stringify({ session_id: "s1", hook_event_name: "Stop", stop_hook_active: false }), dir)
  assert.equal(stop.status, 0)
  assert.equal(JSON.parse(stop.stdout).decision, "block")
  assert.equal(hook(["Stop"], JSON.stringify({ session_id: "s1", hook_event_name: "Stop" }), dir).stdout, "")
  enqueue(dir, { harness: "codex", sessionId: "t1", text: "and update the README" })
  const cx = hook(["codex"], JSON.stringify({ session_id: "t1", turn_id: "u1", hook_event_name: "Stop", stop_hook_active: false }), dir)
  assert.match(JSON.parse(cx.stdout).reason, /update the README/)
})

test("server: steer routes queue, list and cancel for an open session; refuse other sources", async () => {
  const steerDir = tmp()
  const item = { summary: { source: "claude-code", id: "s1", kind: "session" }, lanes: [] }
  const src = { name: "claude-code", harness: "claude-code", listItems: async () => [item.summary], getItem: async (id) => (id === "s1" ? item : null), getCalls: async () => [], getSession: async () => null }
  const other = { name: "native", harness: "native", listItems: async () => [], getItem: async () => item, getCalls: async () => [], getSession: async () => null }
  const distDir = tmp("mc-dist-")
  writeFileSync(join(distDir, "index.html"), "ok")
  const srv = await createServer([src, other], { port: 0, distDir, steerDir })
  const base = `http://127.0.0.1:${srv.port}/api/item`
  const post = (path, body) => fetch(base + path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) })
  try {
    const r = await post("/claude-code/s1/steer", { text: "cover the empty state" })
    assert.equal(r.status, 200)
    const { queued, sent } = await r.json()
    assert.deepEqual(queued.map((m) => m.text), ["cover the empty state"])
    assert.equal((await post("/claude-code/s1/steer", { text: "" })).status, 400)
    assert.equal((await post("/claude-code/nope/steer", { text: "x" })).status, 404)
    assert.notEqual((await post("/native/s1/steer", { text: "x" })).status, 200)
    assert.equal((await (await fetch(base + "/claude-code/s1/steer")).json()).queued.length, 1)
    const c = await (await post("/claude-code/s1/steer/cancel", { id: sent.id })).json()
    assert.deepEqual([c.cancelled, c.queued.length], [true, 0])
  } finally {
    await srv.close()
  }
})
