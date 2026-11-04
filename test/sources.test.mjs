import { test } from "node:test"
import assert from "node:assert/strict"
import { mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import create from "../src/adapters/native.mjs"
import { loadSources } from "../src/adapters/load.mjs"
import { fromAdapter } from "../src/sources/from-adapter.mjs"
import { createRegistry } from "../src/sources/registry.mjs"
import { createServer } from "../src/server.mjs"

const runsDir = fileURLToPath(new URL("./fixtures/runs", import.meta.url))
const native = () => fromAdapter(create({ runsDir }))

test("fromAdapter: one item per run, lanes mapped to the v2 vocabulary", async () => {
  const src = native()
  const items = await src.listItems()
  assert.deepEqual(items.map((i) => i.id), ["20261101-1000-bare", "20261101-0930-stopped", "20261101-0900-done"])
  assert.ok(items.every((i) => i.source === "native" && i.kind === "run"))
  const stopped = await src.getItem("20261101-0930-stopped")
  assert.deepEqual(stopped.lanes.map((l) => [l.id, l.status]), [["setup", "done"], ["build", "done"], ["qa", "waiting"], ["spec", "done"], ["backend", "done"]])
  const backend = stopped.lanes[4]
  assert.deepEqual([backend.calls, backend.cost, backend.tokens.in, backend.tokens.out], [1, 0.11, 400, 150])
  assert.equal(stopped.lanes[2].reason, "needs a human decision on the farewell copy")
  assert.equal(stopped.summary.status, "waiting")
  assert.equal(stopped.summary.waiting, true)
  assert.equal(stopped.summary.cwd, "/work/farewell-wt")
  assert.equal(stopped.summary.title, "add a farewell page")
  const bare = await src.getItem("20261101-1000-bare")
  assert.deepEqual(bare.lanes, [])
  assert.equal(bare.summary.status, "idle")
  assert.deepEqual(await src.getCalls("20261101-1000-bare"), [])
})

test("fromAdapter: a call per progress event, mcp split, tokens from session events", async () => {
  const stopped = await native().getCalls("20261101-0930-stopped")
  assert.equal(stopped.length, 1)
  assert.equal(stopped[0].lane, "backend")
  assert.equal(stopped[0].summary, "farewell route added")
  const done = await native().getItem("20261101-0900-done")
  assert.equal(done.summary.counts.calls, 2)
  assert.equal(done.summary.status, "done")
  assert.deepEqual(done.summary.tokens, { in: 1200, out: 450, cacheRead: 9000, cacheWrite: 300 })
  assert.equal(done.summary.cost, 0.42)
  const calls = await native().getCalls("20261101-0900-done")
  assert.deepEqual(calls.map((c) => c.name), ["progress", "progress"])

  const adapter = {
    name: "stub",
    listRuns: async () => [{ id: "r1" }],
    getRun: async () => ({
      live: true,
      state: { idea: "x", stages: { a: { status: "running" } }, graph: { nodes: { a: { label: "Alpha" } } } },
      events: [
        { ts: "2026-11-01T09:00:00Z", type: "progress", stage: "a", tool: "mcp__files__read_file", detail: "readme" },
        { ts: "2026-11-01T09:01:00Z", type: "progress", stage: "a", tool: "Bash" },
      ],
    }),
    getSession: async () => null,
  }
  const src = fromAdapter(adapter)
  const [mcp, bash] = await src.getCalls("r1")
  assert.deepEqual([mcp.kind, mcp.server, mcp.name], ["mcp", "files", "read_file"])
  assert.deepEqual([bash.kind, bash.name, bash.server], ["tool", "Bash", undefined])
  assert.deepEqual((await src.getCalls("r1", { kind: "mcp" })).length, 1)
  assert.deepEqual((await src.getCalls("r1", { q: "READ" })).length, 1)
  const item = await src.getItem("r1")
  assert.equal(item.lanes[0].label, "Alpha")
  assert.equal(item.lanes[0].status, "working")
  assert.equal(item.lanes[0].nowDoing.name, "Bash")
  assert.equal(item.summary.status, "working")
})

test("registry lists several sources and reports an overview", async () => {
  const other = { ...native(), name: "second", harness: "second" }
  const reg = createRegistry([native(), other])
  const items = await reg.list()
  assert.equal(items.length, 6)
  assert.deepEqual([...new Set(items.map((i) => i.source))].sort(), ["native", "second"])
  assert.equal((await reg.get("second", "20261101-0900-done")).summary.source, "second")
  assert.equal(await reg.get("nope", "x"), null)
  const ov = await reg.overview()
  assert.deepEqual(ov.counts, { waiting: 2, working: 0, stopped: 0, done: 2, ready: 0, looping: 0, closed: 0 })
  assert.deepEqual(ov.needsYou.map((n) => [n.source, n.id, n.title, n.lane, n.detail]).sort(), [
    ["native", "20261101-0930-stopped", "add a farewell page", "qa", "needs a human decision on the farewell copy"],
    ["second", "20261101-0930-stopped", "add a farewell page", "qa", "needs a human decision on the farewell copy"],
  ])
  assert.ok(ov.needsYou.every((n) => !("sessionId" in n)), "v2.3: run-format entries have no hook session, so never answerable")
  assert.equal((await reg.usage({})).length, 4) // two runs with session events in each of the two sources
  assert.equal(reg.usageComplete(), true)
})

test("registry keeps names unique and survives a broken source", async () => {
  const broken = { name: "bad", harness: "bad", listItems: async () => { throw new Error("boom") }, getItem: async () => null, getCalls: async () => [], getSession: async () => null }
  const reg = createRegistry([native(), native(), broken])
  assert.deepEqual(reg.sources().map((s) => s.name), ["native", "native-2", "bad"])
  assert.equal((await reg.list()).length, 6)
})

async function withServer(sources, fn) {
  const distDir = mkdtempSync(join(tmpdir(), "mc-dist-"))
  writeFileSync(join(distDir, "index.html"), "<h1>ok</h1>")
  const srv = await createServer(sources, { port: 0, distDir })
  try { await fn(`http://127.0.0.1:${srv.port}`) } finally { await srv.close() }
}

test("server: v2 routes over two sources, v1 routes still answer", async () => {
  const acted = []
  const a = create({ runsDir })
  a.actions = { say: async (id, body) => (acted.push([id, body]), { ok: true }) }
  a.extras = { ping: async (id) => ({ body: { id } }) }
  const b = { ...create({ runsDir }), name: "other" }
  await withServer([a, b], async (base) => {
    const j = async (p, init) => (await fetch(base + p, init)).json()
    assert.equal((await j("/api/runs")).length, 3)
    assert.equal((await j("/api/run/20261101-0900-done")).state.idea, "add a greeting page")
    assert.equal((await j("/api/capabilities")).adapter, "native")
    assert.deepEqual((await j("/api/sources")).map((s) => s.name), ["native", "other"])
    assert.equal((await j("/api/items")).length, 6)
    const ov = await j("/api/overview")
    assert.deepEqual(ov.counts, { waiting: 2, working: 0, stopped: 0, done: 2, ready: 0, looping: 0, closed: 0 })
    assert.equal(ov.needsYou[0].lane, "qa")
    const item = await j("/api/item/other/20261101-0930-stopped")
    assert.equal(item.summary.source, "other")
    assert.equal(item.lanes.length, 5)
    assert.equal((await j("/api/item/native/20261101-0900-done/calls?kind=tool")).length, 2)
    assert.equal((await j("/api/item/native/20261101-0900-done/session/backend-1.md")).text.includes("backend-1"), true)
    assert.deepEqual(await j("/api/item/native/abc/x/ping"), { id: "abc" })
    const post = await fetch(base + "/api/item/native/20261101-0900-done/action/say", {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ a: 1 }),
    })
    assert.deepEqual(await post.json(), { ok: true })
    assert.deepEqual(acted, [["20261101-0900-done", { a: 1 }]])
    // refusals
    assert.equal((await fetch(base + "/api/item/nope/x")).status, 404)
    assert.equal((await fetch(base + "/api/item/native/missing")).status, 404)
    assert.equal((await fetch(base + "/api/item/native/a%2Fb")).status, 400)
    assert.equal((await fetch(base + "/api/item/native/20261101-0900-done/session/..%2Fstate.json")).status, 400)
    assert.equal((await fetch(base + "/api/item/native/20261101-0900-done/x/nope")).status, 404)
    assert.equal((await fetch(base + "/api/item/native/20261101-0900-done/action/nope", { method: "POST", headers: { "content-type": "application/json" }, body: "{}" })).status, 404)
    const noType = await fetch(base + "/api/item/native/20261101-0900-done/action/say", { method: "POST", body: "{}" })
    assert.equal(noType.status, 415)
  })
})

test("server: pure sources work without any adapter, v1 routes 404", async () => {
  const pure = { name: "p", harness: "p", listItems: async () => [], getItem: async () => null, getCalls: async () => [], getSession: async () => null }
  await withServer(pure, async (base) => {
    assert.deepEqual(await (await fetch(base + "/api/items")).json(), [])
    assert.equal((await fetch(base + "/api/runs")).status, 404)
    assert.equal((await (await fetch(base + "/api/capabilities")).json()).adapter, null)
  })
})

test("loadSources: --runs, --speckit and --adapter become sources together", async () => {
  const root = fileURLToPath(new URL("..", import.meta.url))
  const spec = fileURLToPath(new URL("./fixtures/speckit", import.meta.url))
  const list = await loadSources(["--runs", runsDir, "--speckit", spec], root)
  assert.equal(list.length, 2)
  assert.equal(list[0].name, "native")
  assert.notEqual(list[1].name, "native")
  assert.equal((await loadSources([], mkdtempSync(join(tmpdir(), "mc-cwd-")))).length, 1)
  const dir = mkdtempSync(join(tmpdir(), "mc-ext-"))
  writeFileSync(join(dir, "ext.mjs"), "export default (o) => ({ name: 'ext', listRuns: async () => [], getRun: async () => null, getSession: async () => null })")
  const both = await loadSources(["--adapter", "ext.mjs", "--speckit", spec], dir)
  assert.deepEqual(both.map((a) => a.name).length, 2)
  assert.equal(both[0].name, "ext")
})

test("event-only stage holding the open stop is the waiting lane; broken source reported", async () => {
  const adapter = {
    name: "ronin",
    listRuns: async () => [{ id: "r1" }],
    getRun: async () => ({
      live: false,
      state: { idea: "x", stages: { build: { status: "done" } } },
      events: [
        { ts: "2026-11-01T09:00:00Z", type: "stage.start", stage: "memory" },
        { ts: "2026-11-01T09:01:00Z", type: "stage.end", stage: "memory", ok: false },
        { ts: "2026-11-01T09:02:00Z", type: "stage.start", stage: "learn" },
        { ts: "2026-11-01T09:03:00Z", type: "stop", stage: "learn", rule: "human", detail: "approve the lesson" },
      ],
    }),
    getSession: async () => null,
  }
  const item = await fromAdapter(adapter).getItem("r1")
  assert.deepEqual(item.lanes.map((l) => [l.id, l.status]), [["build", "done"], ["memory", "failed"], ["learn", "waiting"]])
  const broken = { name: "bad", harness: "bad", listItems: async () => { throw new Error("boom") }, getItem: async () => null, getCalls: async () => [], getSession: async () => null }
  const reg = createRegistry([fromAdapter(adapter), broken])
  const pick = ({ source, id, title, lane, detail }) => ({ source, id, title, lane, detail })
  assert.deepEqual((await reg.overview()).needsYou.map(pick), [{ source: "ronin", id: "r1", title: "x", lane: "learn", detail: "approve the lesson" }])
  await withServer([adapter, broken], async (base) => {
    const list = await (await fetch(base + "/api/sources")).json()
    assert.equal(list[0].error, undefined)
    assert.equal(list[1].error, "boom")
  })
})

test("fromAdapter: a stage whose state says running on a run that is not live is idle, not working", async () => {
  const stub = (live) => fromAdapter({
    name: "stub",
    listRuns: async () => [{ id: "r1" }],
    getRun: async () => ({ live, state: { idea: "x", stages: { a: { status: "running" }, b: { status: "done" } } }, events: [] }),
    getSession: async () => null,
  })
  const dead = await stub(false).getItem("r1")
  assert.deepEqual(dead.lanes.map((l) => [l.id, l.status]), [["a", "idle"], ["b", "done"]])
  assert.notEqual(dead.summary.status, "working")
  const alive = await stub(true).getItem("r1")
  assert.equal(alive.lanes[0].status, "working")
})
