import { test } from "node:test"
import assert from "node:assert/strict"
import { mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createDispatcher, startNotifier } from "../src/notify.mjs"
import { createServer } from "../src/server.mjs"

const it = (id, status, extra = {}) => ({ source: "cc", id, title: id, status, open: true, harness: "claude-code", cwd: "/w/shop", branch: "main", ...extra })

test("notifier: done fires once when an open session goes working to idle, not when it closes, moves id, waits or is interrupted", async () => {
  let items = [it("a", "working"), it("b", "working"), it("c", "working"), it("d", "idle"), it("e", "working"), it("f", "working")]
  const sent = []
  const n = startNotifier({ list: async () => items, overview: async () => ({ needsYou: [] }), enabled: (k) => k === "done", notify: (m) => sent.push(`${m.kind} ${m.subtitle} | ${m.where}`), everyMs: 1e9 })
  await n.ready
  items = [it("a", "idle"), it("b", "idle", { open: false }), it("c", "waiting"), it("d", "idle"), it("e", "idle", { parkedInto: "x" }), it("f", "idle", { interrupted: true })]
  await n.pass()
  await n.pass()
  n.stop()
  assert.deepEqual(sent, ["done a | Claude Code · shop · main"])
})

test("notifier: only newly waiting sessions notify, never on the first pass; with nothing on it does no work and replays nothing", async () => {
  let waiting = [{ source: "cc", id: "a", title: "old prompt", detail: "x" }]
  let on = true, lists = 0
  const sent = []
  const n = startNotifier({ list: async () => (lists++, []), overview: async () => ({ needsYou: waiting }), enabled: (k) => on && k === "needs", notify: (m) => sent.push(m.subtitle), everyMs: 1e9 })
  await n.ready
  waiting = [...waiting, { source: "cc", id: "b", title: "day0paywall", detail: "permission for Bash" }]
  await n.pass()
  on = false
  const before = lists
  waiting = [...waiting, { source: "cc", id: "c", title: "while off", detail: "" }]
  await n.pass()
  assert.equal(lists, before) // nothing on: no listing at all
  on = true
  await n.pass() // seeds again: "while off" is not replayed
  n.stop()
  assert.deepEqual(sent, ["day0paywall"])
})

test("dispatcher: one channel each — visible tab, else phone (not for Done), else background tab, else macOS, else none", async () => {
  const got = []
  let pages = { visible: 0, hidden: 0 }, phoneOn = false
  const d = createDispatcher({
    pages: () => pages,
    toPages: (visible, m) => got.push(`${visible ? "visible" : "background"} ${m.kind}`),
    phone: { available: () => phoneOn, ping: async () => (got.push("phone"), 1) },
    mac: (m) => got.push(`mac ${m.kind}`),
  })
  pages = { visible: 1, hidden: 1 }; phoneOn = true
  assert.equal(await d({ kind: "needs" }), "page")
  pages = { visible: 0, hidden: 1 }
  assert.equal(await d({ kind: "needs" }), "phone")
  assert.equal(await d({ kind: "done" }), "page (background)")
  phoneOn = false
  pages = { visible: 0, hidden: 0 }
  assert.equal(await d({ kind: "needs" }), "macOS")
  assert.equal(await createDispatcher({ pages: () => pages, toPages: () => {} })({ kind: "needs" }), "none")
  assert.deepEqual(got, ["visible needs", "phone", "background done", "mac needs"])
})

test("dispatcher: a tab whose switch is off is skipped (the phone gets it), and a ping nobody accepted falls through", async () => {
  const got = []
  let accepted = 1
  const d = createDispatcher({
    pages: () => ({ visible: 1, hidden: 0 }),
    toPages: (visible, m) => got.push(`tab ${m.kind}`),
    phone: { available: () => true, ping: async () => (got.push("ping"), accepted) },
    mac: (m) => got.push(`mac ${m.kind}`),
    wants: (m) => m.kind !== "needs", // Needs you switched off; only the phone asked for it
  })
  assert.equal(await d({ kind: "needs" }), "phone")
  accepted = 0 // an expired subscription: nothing accepted
  assert.equal(await d({ kind: "needs" }), "macOS")
  const failing = createDispatcher({ pages: () => ({ visible: 0, hidden: 0 }), toPages: () => {}, phone: { available: () => true, ping: async () => { throw new Error("down") } }, mac: () => got.push("mac after error") })
  assert.equal(await failing({ kind: "needs" }), "macOS")
  assert.deepEqual(got, ["ping", "ping", "mac needs", "mac after error"])
})

test("macNotify: quotes, backslashes and newlines stay inside the AppleScript strings", async () => {
  const { macNotify } = await import("../src/notify.mjs")
  const calls = []
  macNotify({ title: "Needs you", subtitle: 'say "hi" \\ bye', message: "line1\nline2", where: 'x" & do shell script "rm' }, (cmd, args) => calls.push([cmd, args]))
  assert.equal(calls[0][0], "osascript")
  const script = calls[0][1][1]
  assert.equal(script, 'display notification "x\\" & do shell script \\"rm" with title "say \\"hi\\" \\\\ bye" subtitle "Needs you · line1 line2"')
})

test("server: a notification goes to a visible ?notify=1 page first, a background one next, else the macOS fallback", async () => {
  const dist = mkdtempSync(join(tmpdir(), "mc-dist-"))
  writeFileSync(join(dist, "index.html"), "ok")
  const mac = []
  const src = { name: "cc", harness: "claude-code", listItems: async () => [], getItem: async () => null, getCalls: async () => [], getSession: async () => null }
  const srv = await createServer(src, { port: 0, distDir: dist, notifier: { mac: (m) => mac.push(m.title) } })
  const base = `http://127.0.0.1:${srv.port}`
  const test = async () => (await (await fetch(`${base}/api/settings/test`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" })).json()).via
  const open = async (q) => {
    const r = await fetch(`${base}/api/events${q}`)
    const reader = r.body.getReader()
    await reader.read() // the opening heartbeat
    return reader
  }
  const next = async (reader) => {
    let text = ""
    while (!text.includes("event: notify")) text += new TextDecoder().decode((await reader.read()).value)
    return text
  }
  try {
    assert.equal(await test(), "macOS")
    const plain = await open("") // a page that did not ask: never a channel
    const background = await open("?notify=1&visible=0")
    assert.equal(await test(), "page (background)")
    assert.match(await next(background), /event: notify\ndata: \{"kind":"test","title":"Test"/)
    const visible = await open("?notify=1&visible=1")
    assert.equal(await test(), "page")
    assert.match(await next(visible), /"dismissAfter":10/)
    assert.deepEqual(mac, ["Test"])
    // The tab reports it could not show it: macOS gets it once; a later "shown" changes nothing.
    const ack = (result) => fetch(`${base}/api/events/ack`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ group: "test", result }) })
    await ack("not shown: permission denied")
    await ack("not shown: permission denied")
    assert.deepEqual(mac, ["Test", "Test"])
    for (const r of [plain, background, visible]) await r.cancel()
  } finally { await srv.close() }
})

test("settings: notifications are off until turned on", async () => {
  const { createSettings } = await import("../src/settings.mjs")
  const path = join(mkdtempSync(join(tmpdir(), "mc-set-")), "settings.json")
  assert.deepEqual(createSettings(path).get(), { notify: false, notifyDone: false, notifyDismiss: 10 })
})

test("notifier: one per session (source/id) — a second prompt while the first still waits does not notify again; after it clears, the next does", async () => {
  let waiting = []
  const sent = []
  const n = startNotifier({ list: async () => [], overview: async () => ({ needsYou: waiting }), enabled: (k) => k === "needs", notify: (m) => sent.push(m.message), everyMs: 1e9 })
  await n.ready
  waiting = [{ source: "cc", id: "a", title: "a", detail: "permission for Bash" }]
  await n.pass()
  waiting = [{ source: "cc", id: "a", title: "a", detail: "permission for Edit" }] // a new prompt, same session, still waiting
  await n.pass()
  waiting = []
  await n.pass()
  waiting = [{ source: "cc", id: "a", title: "a", detail: "permission for Write" }]
  await n.pass()
  n.stop()
  assert.deepEqual(sent, ["permission for Bash", "permission for Write"])
})

test("server: a tab that never answers hands the notification to macOS; one that answers 'shown' does not", async () => {
  const dist = mkdtempSync(join(tmpdir(), "mc-dist-"))
  writeFileSync(join(dist, "index.html"), "ok")
  const mac = []
  const src = { name: "cc", harness: "claude-code", listItems: async () => [], getItem: async () => null, getCalls: async () => [], getSession: async () => null }
  const srv = await createServer(src, { port: 0, distDir: dist, notifier: { mac: (m) => mac.push(m.title) }, ackWaitMs: 150 })
  const base = `http://127.0.0.1:${srv.port}`
  const post = (path, body) => fetch(`${base}${path}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) })
  const tab = await fetch(`${base}/api/events?notify=1&visible=1`)
  const reader = tab.body.getReader()
  await reader.read() // the opening heartbeat
  try {
    assert.equal((await (await post("/api/settings/test", {})).json()).via, "page")
    await new Promise((r) => setTimeout(r, 300))
    assert.deepEqual(mac, ["Test"]) // silent tab: macOS took it
    assert.equal((await (await post("/api/settings/test", {})).json()).via, "page")
    await post("/api/events/ack", { group: "test", result: "shown", permission: "granted", visible: "visible" })
    await new Promise((r) => setTimeout(r, 300))
    assert.deepEqual(mac, ["Test"]) // shown: no second banner
  } finally { await reader.cancel(); await srv.close() }
})
