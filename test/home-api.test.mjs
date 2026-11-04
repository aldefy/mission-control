import { test } from "node:test"
import assert from "node:assert/strict"
import { mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createServer } from "../src/server.mjs"
import { createHide, isNoise } from "../src/hidden.mjs"
import { createRegistry } from "../src/sources/registry.mjs"

const T = "2026-11-02T10:00:00.000Z"
const item = (id, cwd, extra = {}) => ({
  id, kind: "session", title: `task ${id}`, harness: "claude-code", cwd, branch: "main", live: false, status: "idle", waiting: false,
  startedAt: T, updatedAt: T, counts: { lanes: 1, calls: 2, errors: 0 }, tokens: { in: 1, out: 1, cacheRead: 0, cacheWrite: 0 }, cost: 0.01, ...extra,
})
const lane = (id, extra = {}) => ({ id, label: id, kind: "main", status: "idle", calls: 0, errors: 0, tokens: { in: 0, out: 0, cacheRead: 0, cacheWrite: 0 }, cost: 0, ...extra })

const ITEMS = [
  item("w1", "/work/shop", { live: true, status: "working" }),
  item("q1", "/work/shop", { status: "waiting", waiting: true }),
  item("d1", "/work/app", { status: "done" }),
  item("noise1", "/home/u/.claude-mem/observer-sessions", { status: "waiting", waiting: true }),
  item("noise2", "/work/observer-sessions", { status: "working", live: true }),
  item("cfg", "/work/secret", { status: "stopped" }),
]
const LANES = {
  w1: [lane("main", { status: "working", nowDoing: { name: "Bash", kind: "tool", summary: "npm test", ts: "2026-11-02T10:00:05.000Z" } }), lane("sub-1", { kind: "subagent", status: "done" })],
  q1: [lane("main", { status: "waiting", reason: "permission for Bash" })],
  noise2: [lane("main", { status: "working", nowDoing: { name: "Read", kind: "tool", summary: "x", ts: T } })],
}
const source = () => ({
  name: "cc", harness: "claude-code",
  listItems: async () => ITEMS.map((i) => ({ ...i })),
  getItem: async (id) => { const s = ITEMS.find((i) => i.id === id); return s ? { summary: s, lanes: LANES[id] ?? [], events: [] } : null },
  getCalls: async () => [], getSession: async () => null,
})
const stubGit = {
  resolve: async (cwd) => ({ commonDir: `${cwd}/.git`, toplevel: cwd }),
  worktrees: async (c) => [{ path: c.replace(/\/\.git$/, ""), branch: "main" }],
  status: async () => ({ dirty: 1, ahead: 2, behind: 0 }),
}

async function withServer(opts, fn) {
  const dist = mkdtempSync(join(tmpdir(), "mc-dist-"))
  writeFileSync(join(dist, "index.html"), "<h1>ok</h1>")
  const srv = await createServer(source(), { port: 0, distDir: dist, git: stubGit, ...opts })
  try { await fn(`http://127.0.0.1:${srv.port}`) } finally { await srv.close() }
}
const configWith = (hide) => {
  const dir = mkdtempSync(join(tmpdir(), "mc-cfg-"))
  const p = join(dir, "config.json")
  writeFileSync(p, JSON.stringify({ hide }))
  return p
}

test("isNoise: tool data dirs, observer-sessions, and the config list by path or name", () => {
  assert.equal(isNoise({ name: "x", path: "/h/.claude-mem/x" }, []), true)
  assert.equal(isNoise({ name: "observer-sessions", path: "/w/observer-sessions" }, []), true)
  assert.equal(isNoise({ name: "shop", path: "/w/shop" }, []), false)
  assert.equal(isNoise({ name: "shop", path: "/w/shop" }, ["shop"]), true)
  assert.equal(isNoise({ name: "shop", path: "/w/shop" }, ["/w/shop"]), true)
  assert.equal(isNoise({ name: "shop", path: "/w/shop" }, ["/w/sho"]), false)
})

test("createHide: missing, broken or odd config files mean no extra hides", () => {
  assert.deepEqual(createHide(null).list(), [])
  assert.deepEqual(createHide("/no/such/config.json").list(), [])
  const dir = mkdtempSync(join(tmpdir(), "mc-cfg-"))
  writeFileSync(join(dir, "bad.json"), "{nope")
  assert.deepEqual(createHide(join(dir, "bad.json")).list(), [])
  writeFileSync(join(dir, "odd.json"), JSON.stringify({ hide: ["a", 3, null, "b"] }))
  assert.deepEqual(createHide(join(dir, "odd.json")).list(), ["a", "b"])
})

test("/api/projects flags hidden projects; slim drops items and carries counts", async () => {
  await withServer({ config: configWith(["secret"]) }, async (base) => {
    const full = await (await fetch(`${base}/api/projects`)).json()
    const hidden = full.filter((p) => p.hidden).map((p) => p.name).sort()
    assert.deepEqual(hidden, ["observer-sessions", "observer-sessions", "secret"])
    assert.ok(full.find((p) => p.name === "shop").worktrees[0].items.length === 2)

    const slim = await (await fetch(`${base}/api/projects?slim=1&tz=UTC`)).json()
    const shop = slim.find((p) => p.name === "shop")
    assert.equal(shop.hidden, undefined)
    const w = shop.worktrees[0]
    assert.equal(w.items, undefined)
    assert.deepEqual(w.counts, { items: 2, live: 1, ready: 0, closed: 0, waiting: 1, looping: 0, working: 1, stopped: 0, failed: 0, done: 0, idle: 0 })
    assert.equal(w.dirty, 1)
    assert.equal(w.ahead, 2)
    assert.equal(w.updatedAt, T)
    assert.ok(JSON.stringify(slim).length < JSON.stringify(full).length)
  })
})

test("slim doneToday counts done items on the viewer's day", async () => {
  await withServer({ now: () => Date.parse("2026-11-02T20:00:00.000Z") }, async (base) => {
    const app = async (tz) => (await (await fetch(`${base}/api/projects?slim=1&tz=${encodeURIComponent(tz)}`)).json()).find((p) => p.name === "app").worktrees[0]
    assert.equal((await app("UTC")).doneToday, 1)
    // 20:00 UTC is already 3 Nov in Kolkata; the item finished on 2 Nov there.
    assert.equal((await app("Asia/Kolkata")).doneToday, 0)
    assert.equal((await fetch(`${base}/api/projects?slim=1&tz=Not/AZone`)).status, 400)
  })
})

test("overview excludes hidden projects unless all=1, and lists live lanes", async () => {
  await withServer({ config: configWith(["secret"]) }, async (base) => {
    const ov = await (await fetch(`${base}/api/overview`)).json()
    assert.deepEqual(ov.counts, { waiting: 1, working: 1, stopped: 0, done: 1, ready: 0, looping: 0, closed: 0 })
    assert.deepEqual(ov.needsYou.map((n) => [n.id, n.lane, n.detail, n.project.name]), [["q1", "main", "permission for Bash", "shop"]])
    assert.deepEqual(ov.live.map((l) => [l.id, l.lane, l.label, l.nowDoing.name, l.project.name]), [["w1", "main", "main", "Bash", "shop"]])
    assert.equal(ov.hidden, 3)
    const all = await (await fetch(`${base}/api/overview?all=1`)).json()
    assert.deepEqual(all.counts, { waiting: 2, working: 2, stopped: 1, done: 1, ready: 0, looping: 0, closed: 0 })
    assert.equal(all.live.length, 2)
  })
})

test("/api/items: placed in a project, hidden left out unless all=1, limit and lookup by id", async () => {
  await withServer({}, async (base) => {
    const items = await (await fetch(`${base}/api/items`)).json()
    assert.deepEqual(items.map((i) => i.id).sort(), ["cfg", "d1", "q1", "w1"])
    const w1 = items.find((i) => i.id === "w1")
    assert.equal(w1.project.name, "shop")
    assert.equal(w1.project.worktree, "/work/shop")
    const tree = await (await fetch(`${base}/api/projects?slim=1`)).json()
    assert.equal(w1.project.key, tree.find((p) => p.name === "shop").key)
    assert.match(w1.project.key, /^shop-[0-9a-f]{8}$/) // V10: folder name, not ".git"
    assert.equal((await (await fetch(`${base}/api/items?all=1`)).json()).length, 6)
    assert.equal((await (await fetch(`${base}/api/items?limit=2`)).json()).length, 2)
    const one = await (await fetch(`${base}/api/items?all=1&source=cc&id=noise1`)).json()
    assert.deepEqual(one.map((i) => [i.id, i.hidden]), [["noise1", true]])
    assert.equal((await fetch(`${base}/api/items?limit=abc`)).status, 400)
  })
})

test("JSON GETs carry an ETag and answer 304 to a matching If-None-Match", async () => {
  await withServer({}, async (base) => {
    const a = await fetch(`${base}/api/projects?slim=1`)
    const tag = a.headers.get("etag")
    assert.match(tag, /^W\/"[0-9a-f]+"$/)
    await a.text()
    const b = await fetch(`${base}/api/projects?slim=1`, { headers: { "if-none-match": tag } })
    assert.equal(b.status, 304)
    assert.equal(await b.text(), "")
    const c = await fetch(`${base}/api/projects?slim=1`, { headers: { "if-none-match": 'W/"different"' } })
    assert.equal(c.status, 200)
    assert.equal(c.headers.get("etag"), tag)
    // errors are never 304
    const e = await fetch(`${base}/api/item/cc/missing`)
    assert.equal(e.status, 404)
    assert.equal(e.headers.get("etag"), null)
  })
})

test("overview loads live items' details at most 6 at a time", async () => {
  let running = 0, peak = 0, calls = 0
  const many = Array.from({ length: 20 }, (_, k) => item(`L${k}`, "/work/shop", { live: true, status: "working" }))
  const src = {
    name: "cc", harness: "claude-code", listItems: async () => many, getCalls: async () => [], getSession: async () => null,
    getItem: async (id) => {
      calls++; running++; peak = Math.max(peak, running)
      await new Promise((r) => setTimeout(r, 5))
      running--
      return { summary: many.find((i) => i.id === id), lanes: [lane("main", { status: "working" })], events: [] }
    },
  }
  const ov = await createRegistry([src]).overview()
  assert.equal(calls, 20)
  assert.ok(peak > 1, `ran serially (peak ${peak})`)
  assert.ok(peak <= 6, `peak ${peak}`)
  assert.equal(ov.live.length, 20)
})

test("/api/items?limit places only about the first chunk", async () => {
  const many = Array.from({ length: 400 }, (_, k) => item(`m${k}`, `/work/p${k}`, { updatedAt: new Date(1e12 - k * 1000).toISOString() }))
  const seen = new Set()
  const git = { ...stubGit, resolve: async (cwd) => { seen.add(cwd); return { commonDir: `${cwd}/.git`, toplevel: cwd } } }
  const dist = mkdtempSync(join(tmpdir(), "mc-dist-"))
  writeFileSync(join(dist, "index.html"), "<h1>ok</h1>")
  const srv = await createServer({ ...source(), listItems: async () => many }, { port: 0, distDir: dist, git })
  try {
    const got = await (await fetch(`http://127.0.0.1:${srv.port}/api/items?limit=10`)).json()
    assert.deepEqual(got.map((i) => i.id), many.slice(0, 10).map((i) => i.id))
    assert.ok(seen.size <= 50, `resolved ${seen.size} cwds`)
  } finally { await srv.close() }
})

test("registry overview accepts a pre-filtered item list", async () => {
  const reg = createRegistry([source()])
  const ov = await reg.overview((await reg.list()).filter((i) => i.id === "q1"))
  assert.deepEqual(ov.counts, { waiting: 1, working: 0, stopped: 0, done: 0, ready: 0, looping: 0, closed: 0 })
  assert.deepEqual(ov.live, [])
})

test("marks: archived leaves items and counts until unarchived; pinned is flagged; bad bodies refused", async () => {
  const marksPath = join(mkdtempSync(join(tmpdir(), "mc-marks-")), "marks.json")
  await withServer({ marksPath }, async (base) => {
    const post = (id, body) => fetch(`${base}/api/item/cc/${id}/mark`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) })
    const ids = async (q = "") => (await (await fetch(`${base}/api/items${q}`)).json()).map((i) => i.id)
    assert.deepEqual(await (await post("q1", { archived: true })).json(), { pinned: false, archived: true })
    await post("w1", { pinned: true })
    assert.ok(!(await ids()).includes("q1"))
    assert.ok((await ids("?archived=1")).includes("q1"))
    assert.equal((await (await fetch(`${base}/api/overview`)).json()).counts.waiting, 0)
    assert.equal((await (await fetch(`${base}/api/items?id=w1`)).json())[0].pinned, true)
    assert.equal((await post("q1", { archived: "yes" })).status, 400)
    assert.equal((await post("q1", { other: true })).status, 400)
    await post("q1", { archived: false })
    assert.ok((await ids()).includes("q1"))
  })
})

test("a chat that changed session id is listed once, under the newest id, which keeps its rename", async () => {
  const titlesPath = join(mkdtempSync(join(tmpdir(), "mc-titles-")), "titles.json")
  writeFileSync(titlesPath, JSON.stringify({ "cc:old": "my chat" }))
  const src = { ...source(), listItems: async () => [item("old", "/work/shop", { parkedInto: "new" }), item("new", "/work/shop", { continuedFrom: "old" })] }
  const dist = mkdtempSync(join(tmpdir(), "mc-dist-"))
  writeFileSync(join(dist, "index.html"), "ok")
  const srv = await createServer(src, { port: 0, distDir: dist, git: stubGit, titlesPath })
  try {
    const items = await (await fetch(`http://127.0.0.1:${srv.port}/api/items`)).json()
    assert.deepEqual(items.map((i) => [i.id, i.title]), [["new", "my chat"]])
  } finally { await srv.close() }
})

test("rename route: sets and restores the title, keeps originalTitle, refuses bad bodies, 501 when off", async () => {
  const titlesPath = join(mkdtempSync(join(tmpdir(), "mc-titles-")), "titles.json")
  await withServer({ titlesPath }, async (base) => {
    const post = (id, body) => fetch(`${base}/api/item/cc/${id}/title`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) })
    const one = async (id) => (await (await fetch(`${base}/api/items?id=${id}`)).json())[0]
    assert.deepEqual(await (await post("w1", { title: "  my   rename " })).json(), { title: "my rename" })
    assert.deepEqual([(await one("w1")).title, (await one("w1")).originalTitle], ["my rename", "task w1"])
    assert.equal((await (await post("w1", { title: "x".repeat(500) })).json()).title.length, 160)
    assert.deepEqual(await (await post("w1", { title: "" })).json(), { title: null })
    assert.equal((await one("w1")).title, "task w1")
    assert.equal((await post("w1", { title: 5 })).status, 400)
    assert.equal((await post("nope", { title: "x" })).status, 404)
  })
  await withServer({}, async (base) => {
    const r = await fetch(`${base}/api/item/cc/w1/title`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ title: "x" }) })
    assert.equal(r.status, 501)
  })
})

test("the phone's Needs you leaves out hidden, archived and parked sessions", async () => {
  const marksPath = join(mkdtempSync(join(tmpdir(), "mc-marks-")), "marks.json")
  const waiting = { status: "waiting", waiting: true }
  const items = [item("a", "/work/shop", waiting), item("arch", "/work/shop", waiting), item("old", "/work/shop", { ...waiting, parkedInto: "a" }), item("noise", "/home/u/.claude-mem/observer-sessions", waiting)]
  const src = { ...source(), listItems: async () => items.map((i) => ({ ...i })), getItem: async (id) => { const s = items.find((i) => i.id === id); return s ? { summary: s, lanes: [], events: [] } : null } }
  const dist = mkdtempSync(join(tmpdir(), "mc-dist-"))
  writeFileSync(join(dist, "index.html"), "ok")
  const srv = await createServer(src, { port: 0, distDir: dist, git: stubGit, marksPath })
  try {
    const r = await fetch(`http://127.0.0.1:${srv.port}/api/item/cc/arch/mark`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ archived: true }) })
    assert.equal(r.status, 200, await r.text())
    assert.deepEqual((await srv.needsYou()).map((n) => n.id), ["a"])
  } finally { await srv.close() }
})

test("an archived session that is open stays listed, flagged archived; closed, it is hidden", async () => {
  const marksPath = join(mkdtempSync(join(tmpdir(), "mc-marks-")), "marks.json")
  let open = true
  const live1 = () => item("live1", "/work/shop", { open })
  const src = { ...source(), listItems: async () => [live1()], getItem: async (id) => (id === "live1" ? { summary: live1(), lanes: [], events: [] } : null) }
  const dist = mkdtempSync(join(tmpdir(), "mc-dist-"))
  writeFileSync(join(dist, "index.html"), "ok")
  const srv = await createServer(src, { port: 0, distDir: dist, git: stubGit, marksPath })
  const base = `http://127.0.0.1:${srv.port}`
  try {
    await fetch(`${base}/api/item/cc/live1/mark`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ archived: true }) })
    assert.deepEqual((await (await fetch(`${base}/api/items`)).json()).map((i) => [i.id, i.archived]), [["live1", true]])
    open = false
    assert.deepEqual(await (await fetch(`${base}/api/items`)).json(), [])
  } finally { await srv.close() }
})
