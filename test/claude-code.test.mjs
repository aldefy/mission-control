import { test } from "node:test"
import assert from "node:assert/strict"
import { appendFileSync, mkdtempSync, mkdirSync, statSync, symlinkSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import create, { comparableStart, processStart } from "../src/sources/claude-code/index.mjs"
import { PRICES, costOf, family, version } from "../src/sources/claude-code/prices.mjs"
import { parseTranscript } from "../src/sources/claude-code/parse.mjs"
import { createCache } from "../src/sources/claude-code/cache.mjs"
import { spawn } from "node:child_process"
import { createServer as net } from "node:net"
import { loadClaude, parseArgs } from "../src/adapters/load.mjs"
import { createRegistry } from "../src/sources/registry.mjs"

const root = fileURLToPath(new URL("./fixtures/claude/projects", import.meta.url))
const s1Mtime = statSync(join(root, "-work-shop/s1.jsonl")).mtimeMs
const src = (now) => create({ root, now: () => now ?? s1Mtime + 3_600_000 })
const near = (a, b) => assert.ok(Math.abs(a - b) < 1e-9, `${a} != ${b}`)

test("list: two sessions with cwd, branch and title, no full parse", async () => {
  const items = await src().listItems()
  assert.equal(items.length, 2)
  const s1 = items.find((i) => i.id === "s1")
  assert.deepEqual([s1.source, s1.kind, s1.harness, s1.cwd, s1.branch, s1.title], ["claude-code", "session", "claude-code", "/work/shop", "feat/cart", "Add a cart page"])
  assert.equal(s1.counts.lanes, 2)
  const s2 = items.find((i) => i.id === "s2")
  assert.deepEqual([s2.cwd, s2.branch, s2.title, s2.counts.lanes], ["/work/shop", "main", "fix the checkout bug", 1])
  assert.equal(s2.startedAt, "2026-11-01T08:00:00.000Z")
})

test("item: main lane plus one subagent lane labelled from meta", async () => {
  const { summary, lanes } = await src().getItem("s1")
  assert.deepEqual(lanes.map((l) => [l.id, l.kind, l.label, l.parent ?? null]), [["main", "main", "main", null], ["agent-a1", "subagent", "Final whole-branch review", "main"]])
  const sub = lanes[1]
  assert.equal(sub.model, "sonnet")
  assert.equal(sub.agentType, "general-purpose")
  assert.equal(sub.status, "done")
  assert.equal(sub.calls, 1)
  assert.deepEqual(summary.counts, { lanes: 2, calls: 6, errors: 1 })
  assert.equal(lanes[0].model, "claude-opus-4-1")
  assert.equal(lanes[0].calls, 5)
  assert.equal(lanes[0].errors, 1)
  assert.equal(summary.title, "Add a cart page")
})

test("calls: mcp, skill, agent link, error, durations; truncated last line skipped", async () => {
  const calls = await src().getCalls("s1")
  const by = Object.fromEntries(calls.map((c) => [c.id, c]))
  assert.equal(calls.length, 6)
  assert.deepEqual([by.toolu_ctx.kind, by.toolu_ctx.server, by.toolu_ctx.name, by.toolu_ctx.durationMs, by.toolu_ctx.ok], ["mcp", "ctx", "query-docs", 4000, true])
  assert.deepEqual([by.toolu_skill.kind, by.toolu_skill.name, by.toolu_skill.durationMs], ["skill", "brainstorming", 2000])
  assert.deepEqual([by.toolu_bash.kind, by.toolu_bash.ok, by.toolu_bash.error, by.toolu_bash.durationMs, by.toolu_bash.summary], ["tool", false, "1 failing", 6000, "npm test"])
  assert.deepEqual([by.toolu_agent.kind, by.toolu_agent.subLane, by.toolu_agent.summary], ["agent", "agent-a1", "Final whole-branch review"])
  assert.equal(by.toolu_sread.lane, "agent-a1")
  assert.equal(by.toolu_sread.durationMs, 5000)
  assert.equal(by.toolu_read.ok, undefined) // no result yet
  assert.deepEqual(calls.map((c) => c.ts), [...calls.map((c) => c.ts)].sort())
})

test("calls: lane, kind and q filters", async () => {
  const s = src()
  assert.deepEqual((await s.getCalls("s1", { lane: "agent-a1" })).map((c) => c.id), ["toolu_sread"])
  assert.deepEqual((await s.getCalls("s1", { kind: "mcp" })).map((c) => c.id), ["toolu_ctx"])
  assert.deepEqual((await s.getCalls("s1", { q: "NPM" })).map((c) => c.id), ["toolu_bash"])
  assert.deepEqual(await s.getCalls("nope"), [])
})

test("nowDoing: the call still without a result, else the last call", async () => {
  const s = src()
  const l1 = (await s.getItem("s1")).lanes
  assert.equal(l1[0].nowDoing.name, "Read")
  assert.equal(l1[0].nowDoing.summary, "/work/shop/src/cart.ts")
  assert.equal(l1[1].nowDoing, undefined) // finished subagent
  const l2 = (await s.getItem("s2")).lanes
  assert.equal(l2[0].nowDoing.name, "Grep")
})

test("tokens count once per assistant message id; cost uses the price table", async () => {
  const { summary, lanes } = await src().getItem("s1")
  assert.deepEqual(lanes[0].tokens, { in: 3500, out: 600, cacheRead: 18000, cacheWrite: 400 })
  near(lanes[0].cost, 0.132)
  near(lanes[1].cost, 0.004455)
  near(summary.cost, 0.136455)
  assert.deepEqual(summary.tokens, { in: 4200, out: 730, cacheRead: 18100, cacheWrite: 500 })
  // After an open, the list carries the totals too.
  const s = src()
  const unopened = (await s.listItems()).find((i) => i.id === "s1")
  assert.deepEqual([unopened.counts.calls, unopened.partial], [0, true]) // the page shows "–"
  await s.getItem("s1")
  const listed = (await s.listItems()).find((i) => i.id === "s1")
  assert.deepEqual([listed.counts.calls, listed.counts.errors, listed.tokens.in, listed.partial], [6, 1, 4200, undefined])
})

test("prices: family match, table values, unknown model is free", () => {
  assert.equal(family("claude-opus-4-1-20250805"), "opus-4")
  assert.equal(family("gpt-x"), null)
  near(costOf("claude-sonnet-4-5", { in: 1e6, out: 1e6, cacheRead: 1e6, cacheWrite: 1e6 }), PRICES.sonnet.input + PRICES.sonnet.output + PRICES.sonnet.cacheRead + PRICES.sonnet.cacheWrite)
  assert.equal(costOf("mystery", { in: 5, out: 5, cacheRead: 5, cacheWrite: 5 }), 0)
  assert.ok(PRICES.opus.output > PRICES.sonnet.output && PRICES.sonnet.output > PRICES.haiku.output)
})

test("I4 prices: by family and version, list-price estimate", () => {
  const cases = {
    "claude-opus-4-1-20250805": "opus-4", "claude-opus-4-1": "opus-4", "claude-opus-4-20250514": "opus-4", "claude-3-opus-20240229": "opus-4",
    "claude-opus-4-5-20251101": "opus", "claude-opus-4-6": "opus", "claude-opus-5-5": "opus", "claude-opus-5": "opus", opus: "opus", "Opus 4.5": "opus",
    "claude-sonnet-4-5": "sonnet", "claude-3-7-sonnet-20250219": "sonnet", sonnet: "sonnet",
    "claude-3-5-haiku-20241022": "haiku-3-5", "claude-3-haiku-20240307": "haiku-3", "claude-haiku-4-5-20251001": "haiku", haiku: "haiku",
    "gpt-x": null, "": null,
  }
  for (const [m, f] of Object.entries(cases)) assert.equal(family(m), f, m)
  assert.deepEqual(version("claude-opus-5-5"), { family: "opus", major: 5, minor: 5 })
  assert.deepEqual(version("claude-3-5-haiku-20241022"), { family: "haiku", major: 3, minor: 5 })
  assert.deepEqual(version("opus"), { family: "opus", major: null, minor: 0 })
  const m1 = { in: 1e6, out: 0, cacheRead: 0, cacheWrite: 0 }, o1 = { in: 0, out: 1e6, cacheRead: 0, cacheWrite: 0 }
  const pair = (m) => [costOf(m, m1), costOf(m, o1)]
  assert.deepEqual(pair("claude-opus-4-1"), [15, 75])
  assert.deepEqual(pair("claude-opus-5-5"), [5, 25])
  assert.deepEqual(pair("opus"), [5, 25])
  assert.deepEqual(pair("claude-sonnet-4-5"), [3, 15])
  assert.deepEqual(pair("claude-3-5-haiku-20241022"), [0.8, 4])
  assert.deepEqual(pair("claude-haiku-4-5"), [1, 5])
  // Haiku 3 has its own (lower) list price, with its published cache rates
  assert.deepEqual(pair("claude-3-haiku-20240307"), [0.25, 1.25])
  near(costOf("claude-3-haiku-20240307", { in: 0, out: 0, cacheRead: 1e6, cacheWrite: 1e6 }), 0.03 + 0.3)
  near(costOf("claude-opus-5-5", { in: 0, out: 0, cacheRead: 1e6, cacheWrite: 1e6 }), 5 * 0.1 + 5 * 1.25)
})

test("live: mtime within two minutes of the injected now", async () => {
  const live = (await src(s1Mtime + 60_000).listItems()).find((i) => i.id === "s1")
  assert.deepEqual([live.live, live.status], [true, "working"])
  assert.equal((await src(s1Mtime + 60_000).getItem("s1")).lanes[0].status, "working")
  const idle = (await src(s1Mtime + 3 * 60_000).listItems()).find((i) => i.id === "s1")
  assert.deepEqual([idle.live, idle.status, idle.waiting], [false, "idle", false])
  assert.equal((await src(s1Mtime + 3 * 60_000).getItem("s1")).summary.status, "idle")
})

test("getSession: main and subagent transcripts; traversal and absolute names refused", async () => {
  const s = src()
  const main = await s.getSession("s1", "main.jsonl")
  assert.match(main.text, /please add a cart page/)
  assert.match((await s.getSession("s1", "agent-a1.jsonl")).text, /looks fine/)
  assert.equal(await s.getSession("s1", "agent-nope.jsonl"), null)
  for (const name of ["../x", "../s2.jsonl", "/etc/passwd", "..%2fx", "agent-../../s2.jsonl", "..jsonl", "s2.jsonl", "x.txt", ""]) {
    assert.equal(await s.getSession("s1", name), null, name)
  }
  for (const id of ["../s1", "-work-shop/s1", "/etc", "..", ""]) assert.equal(await s.getSession(id, "main.jsonl"), null, id)
  assert.equal(await s.getItem("../s1"), null)
})

test("confinement: a symlink pointing out of the root is never read", async () => {
  const outside = mkdtempSync(join(tmpdir(), "mc-out-"))
  writeFileSync(join(outside, "secret.jsonl"), '{"type":"user","cwd":"/leak","message":{"content":"SECRET"}}\n')
  const r = mkdtempSync(join(tmpdir(), "mc-cc-"))
  mkdirSync(join(r, "-p"))
  symlinkSync(join(outside, "secret.jsonl"), join(r, "-p", "evil.jsonl"))
  const s = create({ root: r })
  assert.deepEqual(await s.listItems(), [])
  assert.equal(await s.getSession("evil", "main.jsonl"), null)
  assert.equal(await s.getItem("evil"), null)
})

test("robustness: missing root, empty and garbage files never throw", async () => {
  assert.deepEqual(await create({ root: join(tmpdir(), "mc-does-not-exist-xyz") }).listItems(), []) // no ~/.claude yet is normal
  const r = mkdtempSync(join(tmpdir(), "mc-cc-"))
  mkdirSync(join(r, "-p"))
  writeFileSync(join(r, "-p", "empty.jsonl"), "")
  writeFileSync(join(r, "-p", "junk.jsonl"), "not json\n[1,2]\nnull\n{")
  const s = create({ root: r })
  const items = await s.listItems()
  assert.deepEqual(items.map((i) => i.id).sort(), ["empty", "junk"])
  assert.equal(items[0].title, items[0].id)
  const item = await s.getItem("junk")
  assert.deepEqual([item.lanes.length, item.summary.counts.calls], [1, 0])
})

test("a /rename, else Claude Code's generated title, past the 64 KB head titles the session", async () => {
  const r = mkdtempSync(join(tmpdir(), "mc-cc-"))
  mkdirSync(join(r, "-p"))
  const user = (text) => JSON.stringify({ type: "user", cwd: "/work", timestamp: "2026-01-01T00:00:00Z", message: { role: "user", content: text } })
  const rename = (t) => JSON.stringify({ type: "custom-title", customTitle: t, sessionId: "s" })
  const filler = Array.from({ length: 100 }, () => user("x".repeat(1000)))
  const ai = (t) => JSON.stringify({ type: "ai-title", aiTitle: t })
  writeFileSync(join(r, "-p", "s.jsonl"), [user("a long first prompt"), rename("old"), ...filler, rename("day0paywall"), ai("Paywall work"), user("more")].join("\n") + "\n")
  writeFileSync(join(r, "-p", "g.jsonl"), [user("a long first prompt"), ...filler, ai("Generated title")].join("\n") + "\n")
  const s = create({ root: r })
  const titles = Object.fromEntries((await s.listItems()).map((i) => [i.id, i.title]))
  assert.deepEqual(titles, { s: "day0paywall", g: "Generated title" }) // /rename beats Claude Code's own title
  assert.equal((await s.getItem("s")).summary.title, "day0paywall")
  assert.equal((await s.getItem("g")).summary.title, "Generated title")
})

test("open state from <config>/sessions/<pid>.json: busy is working, a dead pid or no file is closed", async () => {
  const cfg = mkdtempSync(join(tmpdir(), "mc-cc-"))
  const r = join(cfg, "projects")
  mkdirSync(join(r, "-p"), { recursive: true })
  mkdirSync(join(cfg, "sessions"))
  for (const id of ["busy", "idle", "dead", "none", "parked"]) writeFileSync(join(r, "-p", `${id}.jsonl`), JSON.stringify({ type: "user", cwd: "/w", message: { role: "user", content: id } }) + "\n")
  const reg = (pid, sessionId, status, kind, extra = {}) => writeFileSync(join(cfg, "sessions", `${pid}.json`), JSON.stringify({ pid, sessionId, status, kind, ...extra }))
  reg(process.pid, "busy", "busy", "bg", { jobId: "job1" })
  reg(1, "parked", "busy", "interactive", { parkedJobId: "job1" }) // pid 1 always exists
  reg(process.ppid, "idle", "idle")
  reg(2 ** 22 + 7, "dead", "busy") // above macOS and Linux pid limits: never a running process
  const s = create({ root: r })
  const got = Object.fromEntries((await s.listItems()).map((i) => [i.id, [i.open, i.status]]))
  assert.deepEqual(got, { busy: [true, "working"], idle: [true, "idle"], dead: [false, "idle"], none: [false, "idle"], parked: [true, "idle"] })
  assert.deepEqual([(await s.getItem("busy")).summary.open, (await s.getItem("dead")).summary.open], [true, false])
  const ready = Object.fromEntries((await s.listItems()).map((i) => [i.id, !!i.ready]))
  assert.deepEqual(ready, { busy: false, idle: true, dead: false, none: false, parked: false }) // open and not busy is Ready at once
  assert.equal((await s.getItem("parked")).summary.parkedInto, "busy")
  assert.equal((await s.getItem("busy")).summary.resume, `cd /w && CLAUDE_CONFIG_DIR=${cfg} claude --resume busy`)
})

test("parseTranscript: the newest away_summary is the recap, without the /config hint", () => {
  const recap = (t, ts) => JSON.stringify({ type: "system", subtype: "away_summary", content: `${t} (disable recaps in /config)`, timestamp: ts })
  const p = parseTranscript([recap("old", "2026-11-01T00:00:00Z"), recap("Tests pass; next, commit.", "2026-11-02T00:00:00Z")].join("\n"))
  assert.deepEqual(p.meta.recap, { text: "Tests pass; next, commit.", ts: "2026-11-02T00:00:00Z" })
})

test("a live pid that started at another time than its sessions file says is a reused pid: closed", async () => {
  const cfg = mkdtempSync(join(tmpdir(), "mc-cc-"))
  const r = join(cfg, "projects")
  mkdirSync(join(r, "-p"), { recursive: true })
  mkdirSync(join(cfg, "sessions"))
  for (const id of ["same", "reused"]) writeFileSync(join(r, "-p", `${id}.jsonl`), JSON.stringify({ type: "user", cwd: "/w", message: { role: "user", content: id } }) + "\n")
  writeFileSync(join(cfg, "sessions", `${process.pid}.json`), JSON.stringify({ pid: process.pid, sessionId: "same", status: "idle", procStart: "Tue Nov  3 06:39:58 2026" }))
  writeFileSync(join(cfg, "sessions", "1.json"), JSON.stringify({ pid: 1, sessionId: "reused", status: "idle", procStart: "Mon Oct  5 09:00:00 2026" }))
  const startOf = (pid) => (pid === process.pid ? "Tue Nov 3 06:39:58 2026" : "Sat Oct 31 08:00:00 2026")
  const got = Object.fromEntries((await create({ root: r, startOf }).listItems()).map((i) => [i.id, i.open]))
  assert.deepEqual(got, { same: true, reused: false })
})

test("processStart: ps lstart in UTC, whitespace folded; null when ps fails or is missing; cached per pid", () => {
  const calls = []
  const spawn = (cmd, args, opts) => (calls.push([cmd, args.join(" "), opts.env.TZ]), { status: 0, stdout: "Tue Nov  3 06:39:58 2026\n" })
  assert.equal(processStart(91001, { spawn }), "Tue Nov 3 06:39:58 2026")
  assert.equal(processStart(91001, { spawn }), "Tue Nov 3 06:39:58 2026")
  assert.deepEqual(calls, [["ps", "-o lstart= -p 91001", "UTC"]]) // the second answer came from the cache
  assert.equal(processStart(91002, { spawn: () => ({ status: 1, stdout: "" }) }), null)
  assert.equal(processStart(91003, { spawn: () => { throw new Error("no ps") } }), null)
})

test("parseTranscript: half-written last line is skipped", () => {
  const p = parseTranscript('{"type":"user","timestamp":"2026-11-02T09:00:00Z","message":{"content":"hi"}}\n{"type":"assistant","message":{"id":"x","content":[{"type":"tool_u')
  assert.deepEqual([p.calls.length, p.meta.title], [0, "hi"])
})

test("cache: keyed by path+size+mtime, evicts the oldest", () => {
  const c = createCache(2)
  const k = (m) => c.key("/f", { size: 1, mtimeMs: m })
  assert.notEqual(k(1), k(2))
  c.set("a", 1); c.set("b", 2); c.get("a"); c.set("c", 3)
  assert.deepEqual([c.get("a"), c.get("b"), c.get("c")], [1, undefined, 3])
})

test("works through the registry like any other source", async () => {
  const reg = createRegistry([src()])
  assert.equal((await reg.list()).length, 2)
  assert.equal((await reg.get("claude-code", "s1")).summary.source, "claude-code")
  assert.equal((await reg.calls("claude-code", "s1", { kind: "skill" })).length, 1)
  assert.match((await reg.session("claude-code", "s1", "main.jsonl")).text, /cart/)
})

test("CLI args: claude on by default under <home>/.claude/projects, --claude-dir overrides, --no-claude disables", async () => {
  const home = mkdtempSync(join(tmpdir(), "mc-home-"))
  mkdirSync(join(home, ".claude", "projects", "-p"), { recursive: true })
  writeFileSync(join(home, ".claude", "projects", "-p", "h1.jsonl"), '{"type":"user","cwd":"/work/h","message":{"content":"from home"}}\n')
  const dflt = await loadClaude([], process.cwd(), home)
  assert.equal(dflt.name, "claude-code")
  assert.deepEqual((await dflt.listItems()).map((i) => i.id), ["h1"])
  const over = await loadClaude(["--claude-dir", root], process.cwd(), home)
  assert.equal((await over.listItems()).length, 2)
  assert.equal(await loadClaude(["--no-claude"], process.cwd(), home), null)
  assert.equal(parseArgs(["--no-claude"]).noClaude, true)
  await assert.rejects(async () => parseArgs(["--claude-dir"]), /needs a value/)
})

test("CLI: --claude-dir serves claude-code sessions through the multi-source API", async () => {
  const probe = net()
  await new Promise((r) => probe.listen(0, "127.0.0.1", r))
  const port = probe.address().port
  await new Promise((r) => probe.close(r))
  const bin = fileURLToPath(new URL("../bin/mission-control.mjs", import.meta.url))
  const child = spawn("node", [bin, "--runs", fileURLToPath(new URL("./fixtures/runs", import.meta.url)), "--claude-dir", root, "--port", String(port), "--no-open"], { env: { ...process.env, HOME: mkdtempSync(join(tmpdir(), "mc-home-")) } }) // warm writes the usage cache under HOME
  try {
    await new Promise((res, rej) => {
      child.stdout.on("data", (d) => String(d).includes("\n") && res())
      child.on("exit", () => rej(new Error("exited")))
    })
    const get = (p) => fetch(`http://localhost:${port}${p}`).then((r) => r.json())
    const items = await get("/api/items")
    assert.deepEqual(items.filter((i) => i.source === "claude-code").map((i) => i.id).sort(), ["s1", "s2"])
    assert.ok(items.some((i) => i.source === "native"))
    const item = await get("/api/item/claude-code/s1")
    assert.equal(item.lanes.length, 2)
    assert.equal((await get("/api/item/claude-code/s1/calls?kind=skill")).length, 1)
    assert.match((await get("/api/item/claude-code/s1/session/agent-a1.jsonl")).text, /looks fine/)
    const bad = await fetch(`http://localhost:${port}/api/item/claude-code/s1/session/..%2Fs2.jsonl`)
    assert.equal(bad.status, 400)
  } finally { child.kill() }
})

/** A synthetic session with `n` subagent lanes, each with one Bash call. */
function bigSession(n) {
  const r = mkdtempSync(join(tmpdir(), "mc-big-"))
  const dir = join(r, "-w", "big", "subagents")
  mkdirSync(dir, { recursive: true })
  const ts = (s) => `2026-11-02T09:${String(Math.floor(s / 60) % 60).padStart(2, "0")}:${String(s % 60).padStart(2, "0")}.000Z`
  const use = (id, at, cmd) => JSON.stringify({ type: "assistant", timestamp: ts(at), message: { id: `m-${id}`, model: "claude-sonnet-4-5", usage: { input_tokens: 10, output_tokens: 5 }, content: [{ type: "tool_use", id, name: "Bash", input: { command: cmd } }] } })
  const done = (id, at) => JSON.stringify({ type: "user", timestamp: ts(at), message: { content: [{ type: "tool_result", tool_use_id: id, content: "ok" }] } })
  writeFileSync(join(r, "-w", "big.jsonl"), [JSON.stringify({ type: "user", cwd: "/w", timestamp: ts(0), message: { content: "go wide" } }), use("t-main", 1, "ls"), done("t-main", 2)].join("\n") + "\n")
  for (let i = 0; i < n; i++) {
    writeFileSync(join(dir, `agent-a${i}.jsonl`), [use(`t-${i}`, 3 + i, `echo ${i}`), done(`t-${i}`, 4 + i)].join("\n") + "\n")
    writeFileSync(join(dir, `agent-a${i}.meta.json`), JSON.stringify({ description: `lane ${i}` }))
  }
  return { root: r, main: join(r, "-w", "big.jsonl"), sub: (i) => join(dir, `agent-a${i}.jsonl`), use, done }
}

test("C1: 150 subagent lanes parse once; repeat getItem, getCalls and overview re-parse nothing", async () => {
  const b = bigSession(150)
  const reads = []
  const s = create({ root: b.root, onParse: (path, r) => reads.push({ path, ...r }) })
  const first = await s.getItem("big")
  assert.equal(first.lanes.length, 151)
  assert.equal(reads.length, 151)
  assert.ok(reads.every((r) => r.full))
  reads.length = 0
  for (let k = 0; k < 3; k++) {
    assert.equal((await s.getItem("big")).lanes.length, 151)
    assert.equal((await s.getCalls("big")).length, 151)
    assert.equal((await s.getCalls("big", { lane: "agent-a7" })).length, 1)
  }
  await createRegistry([s]).overview([{ source: "claude-code", id: "big", status: "working", live: true }])
  assert.equal(reads.length, 0, "no re-parse while no file changed")
  // One subagent grows: only that file, only its new bytes.
  const line = b.use("t-more", 200, "echo more") + "\n"
  appendFileSync(b.sub(42), line)
  assert.equal((await s.getCalls("big", { lane: "agent-a42" })).length, 2)
  assert.deepEqual(reads.map((r) => [r.path.endsWith("agent-a42.jsonl"), r.bytes, r.full]), [[true, Buffer.byteLength(line), false]])
})

test("I2: an appended transcript parses only the new bytes; a half-written line waits; a shrunk file re-parses", async () => {
  const b = bigSession(1)
  const reads = []
  const s = create({ root: b.root, onParse: (path, r) => path.endsWith("big.jsonl") && reads.push(r) })
  assert.equal((await s.getCalls("big", { lane: "main" })).length, 1)
  assert.equal((await s.getTurns("big", "main")).total, 2)
  assert.equal(reads.length, 2) // item/calls and turns: one full read each
  reads.length = 0
  const full = b.use("t-2", 300, "npm test") + "\n"
  const half = full.slice(0, 40)
  appendFileSync(b.main, half)
  assert.equal((await s.getCalls("big", { lane: "main" })).length, 1, "half-written line is not a call yet")
  appendFileSync(b.main, full.slice(40) + b.done("t-2", 301) + "\n")
  const calls = await s.getCalls("big", { lane: "main" })
  assert.deepEqual(calls.map((c) => [c.id, c.ok]), [["t-main", true], ["t-2", true]])
  assert.deepEqual(reads.map((r) => [r.bytes, r.full]), [[40, false], [Buffer.byteLength(full) - 40 + Buffer.byteLength(b.done("t-2", 301)) + 1, false]])
  reads.length = 0
  assert.equal((await s.getTurns("big", "main")).total, 3)
  assert.deepEqual(reads.map((r) => r.full), [false])
  // Rewritten shorter: a full parse, not a stale append.
  reads.length = 0
  writeFileSync(b.main, JSON.stringify({ type: "user", cwd: "/w", timestamp: "2026-11-02T10:00:00.000Z", message: { content: "fresh" } }) + "\n")
  assert.equal((await s.getCalls("big", { lane: "main" })).length, 0)
  assert.deepEqual(reads.map((r) => r.full), [true])
})

test("minor 8: a transcript is read in chunks, never as one string, and getSession reads only its cap", async () => {
  const b = bigSession(0)
  // ~9 MB of filler lines (more than one read chunk) between the calls.
  const filler = JSON.stringify({ type: "system", content: "x".repeat(1000) }) + "\n"
  appendFileSync(b.main, filler.repeat(9000) + b.use("t-late", 400, "late") + "\n")
  const s = create({ root: b.root })
  assert.deepEqual((await s.getCalls("big")).map((c) => c.id), ["t-main", "t-late"])
  const sess = await s.getSession("big", "main.jsonl")
  assert.equal(sess.truncated, true)
  assert.equal(Buffer.byteLength(sess.text) <= 200_000 + 3, true)
})

test("v2.2: a subagent file that fails to read once is retried on the next call, not hidden until it changes", async (t) => {
  if (process.getuid?.() === 0) return t.skip("root reads anything")
  const b = bigSession(1)
  const { chmodSync } = await import("node:fs")
  const s = create({ root: b.root })
  chmodSync(b.sub(0), 0o000)
  try {
    assert.equal((await s.getItem("big")).lanes.length, 1, "unreadable subagent is left out")
  } finally { chmodSync(b.sub(0), 0o644) }
  // Same size and mtime as before (chmod changes neither): the lane must still appear now.
  assert.equal((await s.getItem("big")).lanes.length, 2)
})

test("a chat parked on a job whose process has exited stays listed; procStart is compared only in lstart form", async () => {
  const cfg = mkdtempSync(join(tmpdir(), "mc-cc-"))
  const r = join(cfg, "projects")
  mkdirSync(join(r, "-p"), { recursive: true })
  mkdirSync(join(cfg, "sessions"))
  for (const id of ["parked", "linux"]) writeFileSync(join(r, "-p", `${id}.jsonl`), JSON.stringify({ type: "user", cwd: "/w", message: { role: "user", content: id } }) + "\n")
  writeFileSync(join(cfg, "sessions", "1.json"), JSON.stringify({ pid: 1, sessionId: "parked", status: "idle", parkedJobId: "gone-job" }))
  writeFileSync(join(cfg, "sessions", `${process.pid}.json`), JSON.stringify({ pid: process.pid, sessionId: "linux", status: "idle", procStart: "1730619905", pidDomain: "linux" }))
  const s = create({ root: r, startOf: () => "Sat Oct 31 08:00:00 2026" })
  const got = Object.fromEntries((await s.listItems()).map((i) => [i.id, [i.open, i.parkedInto ?? null]]))
  assert.deepEqual(got, { parked: [true, null], linux: [true, null] })
  assert.equal(comparableStart({ procStart: "Tue Nov  3 16:45:05 2026" }), true)
  assert.equal(comparableStart({ procStart: "Tue Nov  3 16:45:05 2026", pidDomain: "linux" }), false)
  assert.equal(comparableStart({ procStart: "2026-11-03T16:45:05Z" }), false)
})
