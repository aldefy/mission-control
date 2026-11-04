import { test } from "node:test"
import assert from "node:assert/strict"
import { request } from "node:http"
import { createServer as netServer, connect } from "node:net"
import { existsSync, mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync, appendFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createRemoteServer, createRemoteControl } from "../src/remote/server.mjs"
import { createPairingToken, revokeDevice } from "../src/remote/pairing.mjs"
import { newPromptId, pendingDir, readDecision, writePending } from "../src/remote/prompts.mjs"

const HOST = "laptop.tail1234.ts.net"
const ORIGIN = `https://${HOST}`

function env() {
  const home = mkdtempSync(join(tmpdir(), "mc-home-"))
  const mc = join(home, ".mission-control")
  const remoteDir = join(mc, "remote"), hooksDir = join(mc, "hooks")
  mkdirSync(hooksDir, { recursive: true })
  const distDir = join(home, "dist")
  mkdirSync(join(distDir, "assets"), { recursive: true })
  mkdirSync(join(distDir, "icons"), { recursive: true })
  writeFileSync(join(distDir, "remote.html"), "<!doctype html><title>remote</title>")
  writeFileSync(join(distDir, "index.html"), "<!doctype html><title>DASHBOARD</title>")
  writeFileSync(join(distDir, "manifest.webmanifest"), "{}")
  writeFileSync(join(distDir, "sw.js"), "self.x=1")
  writeFileSync(join(distDir, "icons", "icon-192.png"), "png")
  writeFileSync(join(distDir, "assets", "remote-abc.js"), "js")
  writeFileSync(join(home, "secret.txt"), "TOP SECRET")
  return { home, remoteDir, hooksDir, distDir, configPath: join(mc, "config.json") }
}

/** One HTTP request with full header control: { status, headers, body, json }. */
function req(port, { method = "GET", path = "/", headers = {}, body } = {}) {
  return new Promise((ok, fail) => {
    const h = { host: HOST, ...headers }
    for (const k of Object.keys(h)) if (h[k] === undefined) delete h[k]
    const r = request({ host: "127.0.0.1", port, method, path, headers: h }, (res) => {
      let b = ""
      res.on("data", (d) => (b += d))
      res.on("end", () => { let j = null; try { j = JSON.parse(b) } catch { /* not json */ } ok({ status: res.statusCode, headers: res.headers, body: b, json: j }) })
    })
    r.on("error", fail)
    if (body !== undefined) r.write(typeof body === "string" ? body : JSON.stringify(body))
    r.end()
  })
}
const post = (port, path, body, headers = {}) => req(port, { method: "POST", path, body, headers: { origin: ORIGIN, "content-type": "application/json", ...headers } })

async function pairDevice(port, e, ua = "Mozilla/5.0 (iPhone) Safari/604.1") {
  const { token } = createPairingToken({ remoteDir: e.remoteDir, host: HOST })
  const r = await post(port, "/api/remote/pair", { token }, { "user-agent": ua })
  assert.equal(r.status, 200, r.body)
  return { cookie: r.headers["set-cookie"][0].split(";")[0], device: r.json.device, raw: r.headers["set-cookie"][0] }
}

async function withRemote(fn, { needsYou = [] } = {}) {
  const e = env()
  const srv = await createRemoteServer({ port: 0, host: HOST, ...e, needsYou: async () => needsYou, heartbeatMs: 200, scanMs: 100 })
  try { await fn(srv.port, e, srv) } finally { await srv.close() }
}

test("binds 127.0.0.1 only", async () => {
  await withRemote(async (port) => {
    await new Promise((ok, fail) => { const s = connect(port, "127.0.0.1", () => { s.end(); ok() }); s.on("error", fail) })
    const v6 = await new Promise((ok) => { const s = connect(port, "::1", () => { s.end(); ok("open") }); s.on("error", () => ok("refused")) })
    assert.equal(v6, "refused")
  })
})

test("guards: wrong Host 403; Host :443 ok; wrong Origin 403; POST without Origin 403; non-JSON POST 415", async () => {
  await withRemote(async (port) => {
    assert.equal((await req(port, { headers: { host: "localhost" } })).status, 403)
    assert.equal((await req(port, { headers: { host: `127.0.0.1:${port}` } })).status, 403)
    assert.equal((await req(port, { headers: { host: "evil.ts.net" } })).status, 403)
    assert.equal((await req(port, { headers: { host: `${HOST}:443` } })).status, 200)
    assert.equal((await req(port, { headers: { origin: "https://evil.example" } })).status, 403)
    assert.equal((await req(port, { headers: { origin: `http://${HOST}` } })).status, 403)
    for (const path of ["/api/remote/answer", "/api/remote/pair"]) {
      assert.equal((await post(port, path, {}, { host: "evil.example" })).status, 403)
      assert.equal((await post(port, path, {}, { origin: "https://evil.example" })).status, 403)
      assert.equal((await post(port, path, {}, { origin: undefined })).status, 403)
      assert.equal((await post(port, path, "x", { "content-type": "text/plain" })).status, 415)
    }
  })
})

test("static allow-list: the shell paths with C5 types; dashboard APIs, index.html, traversal and other paths 404", async () => {
  await withRemote(async (port) => {
    for (const [p, type] of [["/", /text\/html/], ["/pair", /text\/html/], ["/manifest.webmanifest", /^application\/manifest\+json/], ["/sw.js", /^text\/javascript/], ["/icons/icon-192.png", /image\/png/], ["/assets/remote-abc.js", /text\/javascript/]]) {
      const r = await req(port, { path: p })
      assert.equal(r.status, 200, p)
      assert.match(r.headers["content-type"], type, p)
    }
    assert.equal((await req(port, { path: "/sw.js" })).headers["cache-control"], "no-cache")
    assert.ok(!(await req(port, { path: "/" })).body.includes("DASHBOARD"))
    for (const p of ["/index.html", "/api/items", "/api/calls", "/api/usage", "/api/overview", "/api/events", "/api/remote/enabled", "/api/remote/status", "/foo", "/assets/../../secret.txt", "/assets/%2e%2e%2f%2e%2e%2fsecret.txt", "/icons/missing.png"]) {
      const r = await req(port, { path: p })
      assert.equal(r.status, 404, p)
      assert.ok(!r.body.includes("TOP SECRET"))
    }
    assert.equal((await post(port, "/api/remote/enabled", { enabled: false })).status, 404)
    assert.equal((await req(port, { method: "DELETE", path: "/api/remote/me" })).status, 404)
  })
})

test("pair: 200 + __Host- cookie; second use, unknown 401 with the exact text; malformed 400; 11th failure 429", async () => {
  await withRemote(async (port, e) => {
    const { token } = createPairingToken({ remoteDir: e.remoteDir, host: HOST })
    const ok = await post(port, "/api/remote/pair", { token })
    assert.equal(ok.status, 200)
    assert.deepEqual(Object.keys(ok.json), ["device"])
    assert.match(ok.headers["set-cookie"][0], /^__Host-mc_device=[^;]+; Path=\/; Secure; HttpOnly; SameSite=Strict; Max-Age=31536000$/)
    const again = await post(port, "/api/remote/pair", { token })
    assert.deepEqual([again.status, again.json], [401, { error: "pairing link expired or already used" }])
    assert.equal((await post(port, "/api/remote/pair", { tok: 1 })).status, 400)
    assert.equal((await post(port, "/api/remote/pair", "{bad")).status, 400)
    for (let i = 0; i < 9; i++) assert.equal((await post(port, "/api/remote/pair", { token: `x${i}` })).status, 401)
    const blocked = await post(port, "/api/remote/pair", { token: "y" })
    assert.deepEqual([blocked.status, blocked.json], [429, { error: "too many attempts" }])
  })
})

test("cookie routes: no cookie 401 not paired; valid 200; revoked 401 device revoked + cleared cookie on the next request", async () => {
  await withRemote(async (port, e) => {
    for (const p of ["/api/remote/me", "/api/remote/prompts", "/api/remote/events"]) {
      const r = await req(port, { path: p })
      assert.deepEqual([r.status, r.json], [401, { error: "not paired" }], p)
    }
    assert.deepEqual((await post(port, "/api/remote/answer", { promptId: newPromptId(), bind: "b", decision: "allow" })).json, { error: "not paired" })
    const { cookie, device } = await pairDevice(port, e)
    const me = await req(port, { path: "/api/remote/me", headers: { cookie } })
    assert.deepEqual([me.status, me.json], [200, { device: { id: device.id, label: device.label } }])
    assert.deepEqual((await req(port, { path: "/api/remote/prompts", headers: { cookie } })).json, { prompts: [] })
    revokeDevice({ remoteDir: e.remoteDir, id: device.id })
    const r = await req(port, { path: "/api/remote/me", headers: { cookie } })
    assert.deepEqual([r.status, r.json], [401, { error: "device revoked" }])
    assert.match(r.headers["set-cookie"][0], /^__Host-mc_device=;.*Max-Age=0/)
  })
})

test("end to end: pair -> prompts (answerable entry) -> answer 200 once -> audit line; refusals 409 with reasons", async () => {
  const ny = []
  await withRemote(async (port, e) => {
    const { cookie, device } = await pairDevice(port, e)
    const askedAt = new Date().toISOString()
    const p = writePending(e.remoteDir, { promptId: newPromptId(), harness: "claude-code", sessionId: "s1", kind: "permission", tool: "Bash", target: "rm -rf build", askedAt, pid: process.pid })
    ny.push({ source: "claude-code", id: "s1", sessionId: "s1", harness: "claude-code", title: "shop", lane: "main", since: askedAt, tool: "Bash", target: "rm -rf build" })
    const list = await req(port, { path: "/api/remote/prompts", headers: { cookie } })
    assert.equal(list.status, 200)
    assert.deepEqual(list.json.prompts, [{ source: "claude-code", id: "s1", title: "shop", lane: "main", tool: "Bash", target: "rm -rf build", since: askedAt, answerable: true, promptId: p.promptId, bind: p.bind, kind: "permission" }])
    // bad bodies
    assert.equal((await post(port, "/api/remote/answer", { promptId: p.promptId, bind: p.bind, decision: "always" }, { cookie })).status, 400)
    assert.equal((await post(port, "/api/remote/answer", { promptId: p.promptId, bind: p.bind, decision: "allow", updatedPermissions: [] }, { cookie })).status, 400)
    assert.equal((await post(port, "/api/remote/answer", { promptId: p.promptId }, { cookie })).status, 400)
    const changed = await post(port, "/api/remote/answer", { promptId: p.promptId, bind: "0".repeat(64), decision: "allow" }, { cookie })
    assert.deepEqual([changed.status, changed.json.reason], [409, "changed"])
    assert.ok(!existsSync(join(e.home, ".mission-control", "audit.jsonl")), "refusals are not audited")
    // two taps at once: exactly one 200
    const [a, b] = await Promise.all([1, 2].map(() => post(port, "/api/remote/answer", { promptId: p.promptId, bind: p.bind, decision: "allow" }, { cookie })))
    assert.deepEqual([a.status, b.status].sort(), [200, 409])
    assert.deepEqual((a.status === 200 ? a : b).json, { ok: true })
    assert.equal((a.status === 409 ? a : b).json.reason, "answered")
    assert.equal(readDecision(e.remoteDir, p.promptId).decision, "allow")
    const audit = join(e.home, ".mission-control", "audit.jsonl")
    assert.equal(statSync(audit).mode & 0o777, 0o600)
    const lines = readFileSync(audit, "utf8").trim().split("\n").map((l) => JSON.parse(l))
    assert.equal(lines.length, 1)
    assert.deepEqual([lines[0].device, lines[0].promptId, lines[0].decision, lines[0].tool], [device.id, p.promptId, "allow", "Bash"])
    assert.ok(!readFileSync(audit, "utf8").includes("rm -rf"))
    // unknown id -> gone; terminal answer -> terminal
    assert.equal((await post(port, "/api/remote/answer", { promptId: newPromptId(), bind: p.bind, decision: "deny" }, { cookie })).json.reason, "gone")
    const q = writePending(e.remoteDir, { promptId: newPromptId(), harness: "claude-code", sessionId: "s2", kind: "permission", tool: "Bash", target: "ls", askedAt: new Date().toISOString(), pid: process.pid })
    appendFileSync(join(e.hooksDir, "s2.jsonl"), JSON.stringify({ event: "PostToolUse", sessionId: "s2", ts: new Date(Date.now() + 5).toISOString() }) + "\n")
    assert.equal((await post(port, "/api/remote/answer", { promptId: q.promptId, bind: q.bind, decision: "allow" }, { cookie })).json.reason, "terminal")
  }, { needsYou: ny })
})

test("events: heartbeat within 3 s, changed on a new pending prompt; scan abandons a terminal-cleared prompt", async () => {
  await withRemote(async (port, e) => {
    const { cookie } = await pairDevice(port, e)
    const seen = []
    const r = request({ host: "127.0.0.1", port, path: "/api/remote/events", headers: { host: HOST, cookie } })
    const done = new Promise((ok) => r.on("response", (res) => {
      assert.match(res.headers["content-type"], /^text\/event-stream/)
      res.on("data", (d) => { for (const m of String(d).matchAll(/event: (\w+)\ndata: (.*)\n/g)) seen.push([m[1], m[2]]) })
      res.on("close", ok)
    }))
    r.end()
    await new Promise((ok) => setTimeout(ok, 400))
    assert.ok(seen.some(([ev, data]) => ev === "heartbeat" && data === "{}"))
    const p = writePending(e.remoteDir, { promptId: newPromptId(), harness: "claude-code", sessionId: "s1", kind: "permission", tool: "Bash", target: "ls", askedAt: new Date().toISOString(), pid: process.pid })
    const until = Date.now() + 4000
    while (!seen.some(([ev]) => ev === "changed") && Date.now() < until) await new Promise((ok) => setTimeout(ok, 50))
    assert.ok(seen.some(([ev, data]) => ev === "changed" && data === "{}"))
    appendFileSync(join(e.hooksDir, "s1.jsonl"), JSON.stringify({ event: "PostToolUse", sessionId: "s1", ts: new Date(Date.now() + 5).toISOString() }) + "\n")
    const until2 = Date.now() + 3000
    while (!readDecision(e.remoteDir, p.promptId) && Date.now() < until2) await new Promise((ok) => setTimeout(ok, 50))
    assert.equal(readDecision(e.remoteDir, p.promptId)?.decision, "abandon")
    r.destroy()
    await done.catch(() => {})
  })
})

const freePort = () => new Promise((ok) => { const s = netServer(); s.listen(0, "127.0.0.1", () => { const p = s.address().port; s.close(() => ok(p)) }) })
const refused = (port) => new Promise((ok) => { const s = connect(port, "127.0.0.1", () => { s.end(); ok(false) }); s.on("error", () => ok(true)) })
const auditLines = (home) => { try { return readFileSync(join(home, ".mission-control", "audit.jsonl"), "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l)) } catch { return [] } }

test("control: 422 without remote.host; on opens the listener, persists, audits once; off abandons, closes, persists", async () => {
  const e = env()
  const port = await freePort()
  const logs = []
  const ctl = createRemoteControl({ ...e, dashboardPort: () => 4319, needsYou: async () => [], log: (s) => logs.push(s), heartbeatMs: 200, controlMs: 50 })
  try {
    assert.deepEqual(await ctl.start(), { ok: true })
    assert.equal(ctl.status().enabled, false)
    const srvFile = JSON.parse(readFileSync(join(e.remoteDir, "server.json"), "utf8"))
    assert.deepEqual(Object.keys(srvFile).sort(), ["enabled", "host", "pid", "port", "remotePort", "startedAt", "waitSeconds"])
    const bad = await ctl.setEnabled(true, "dashboard")
    assert.equal(bad.status, 422)
    assert.equal(bad.body.key, "remote.host")
    assert.match(bad.body.error, /remote\.host/)
    assert.deepEqual(auditLines(e.home), [])
    writeFileSync(e.configPath, JSON.stringify({ hide: ["a"], remote: { host: HOST, port } }))
    const on = await ctl.setEnabled(true, "dashboard")
    assert.equal(on.status, 200)
    assert.deepEqual(Object.keys(on.body).sort(), ["devices", "enabled", "host", "pairing", "remotePort", "waitSeconds"])
    assert.deepEqual([on.body.enabled, on.body.host, on.body.remotePort, on.body.waitSeconds], [true, HOST, port, 120])
    assert.equal((await req(port)).status, 200)
    assert.ok(logs.some((l) => l.includes(`tailscale serve --bg --https=443 http://127.0.0.1:${port}`)))
    assert.ok(logs.some((l) => /funnel/i.test(l)))
    assert.deepEqual(JSON.parse(readFileSync(e.configPath, "utf8")), { hide: ["a"], remote: { host: HOST, port, enabled: true } })
    assert.equal(JSON.parse(readFileSync(join(e.remoteDir, "server.json"), "utf8")).enabled, true)
    assert.equal((await ctl.setEnabled(true, "dashboard")).status, 200, "no-op")
    assert.deepEqual(auditLines(e.home).map((l) => [l.actor, l.action]), [["dashboard", "remote-on"]])
    // off: pending prompts abandoned, socket closed before the response, config persisted
    const p = writePending(e.remoteDir, { promptId: newPromptId(), harness: "claude-code", sessionId: "s1", kind: "permission", tool: "Bash", target: "ls", askedAt: new Date().toISOString(), pid: process.pid })
    const off = await ctl.setEnabled(false, "dashboard")
    assert.equal(off.body.enabled, false)
    assert.equal(readDecision(e.remoteDir, p.promptId).decision, "abandon")
    assert.equal(await refused(port), true)
    assert.equal(JSON.parse(readFileSync(e.configPath, "utf8")).remote.enabled, false)
    assert.equal(JSON.parse(readFileSync(join(e.remoteDir, "server.json"), "utf8")).enabled, false)
    assert.deepEqual(auditLines(e.home).map((l) => l.action), ["remote-on", "remote-off"])
    // broken config: 422 key config.json, file untouched
    writeFileSync(e.configPath, "{broken")
    const br = await ctl.setEnabled(true, "dashboard")
    assert.deepEqual([br.status, br.body.key], [422, "config.json"])
    assert.equal(readFileSync(e.configPath, "utf8"), "{broken")
  } finally {
    await ctl.close()
  }
  assert.equal(existsSync(join(e.remoteDir, "server.json")), false, "removed on clean shutdown")
})

test("control: flags override config for this run and never write config; status shows the effective values", async () => {
  const e = env()
  const port = await freePort()
  writeFileSync(e.configPath, JSON.stringify({ remote: { host: "a.ts.net", port: 4330 } }))
  const before = readFileSync(e.configPath)
  const ctl = createRemoteControl({ ...e, flags: { host: "b.ts.net", port }, dashboardPort: () => 4319, needsYou: async () => [], log: () => {}, heartbeatMs: 200 })
  try {
    assert.deepEqual(await ctl.start(), { ok: true })
    const st = ctl.status()
    assert.deepEqual([st.enabled, st.host, st.remotePort], [true, "b.ts.net", port])
    assert.equal((await req(port, { headers: { host: "b.ts.net" } })).status, 200)
    assert.equal((await req(port, { headers: { host: "a.ts.net" } })).status, 403)
    assert.deepEqual(auditLines(e.home), [], "a start via flags is not audited")
  } finally { await ctl.close() }
  assert.deepEqual(readFileSync(e.configPath), before)
})

test("control: a CLI request under remote/control/ is applied and answered in <id>.result.json", async () => {
  const e = env()
  const port = await freePort()
  writeFileSync(e.configPath, JSON.stringify({ remote: { host: HOST, port } }))
  const ctl = createRemoteControl({ ...e, dashboardPort: () => 4319, needsYou: async () => [], log: () => {}, heartbeatMs: 200, controlMs: 30 })
  try {
    await ctl.start()
    const { runRemote } = await import("../src/remote/cli.mjs")
    const out = []
    assert.equal(await runRemote({ args: ["on"], remoteDir: e.remoteDir, home: e.home, configPath: e.configPath, out: (s) => out.push(s), err: (s) => out.push(s) }), 0)
    assert.equal(ctl.status().enabled, true)
    out.length = 0
    await runRemote({ args: ["status"], remoteDir: e.remoteDir, home: e.home, configPath: e.configPath, out: (s) => out.push(s) })
    assert.deepEqual(out, ["remote: on", `host: ${HOST}`, `port: ${port}`, "server: running", "devices: 0"])
    assert.equal(await runRemote({ args: ["off"], remoteDir: e.remoteDir, home: e.home, configPath: e.configPath, out: () => {}, err: () => {} }), 0)
    assert.equal(ctl.status().enabled, false)
    assert.deepEqual(auditLines(e.home).map((l) => [l.actor, l.action]), [["cli", "remote-on"], ["cli", "remote-off"]])
  } finally { await ctl.close() }
})

test("notifications: subscribe needs a paired device and a known push service; a new prompt pings once", async () => {
  const e = env()
  const pings = []
  const srv = await createRemoteServer({ port: 0, host: HOST, ...e, needsYou: async () => [], heartbeatMs: 200, scanMs: 50, pushFetch: async (url, init) => { pings.push({ url, init }); return { status: 201 } } })
  try {
    const port = srv.port
    assert.equal((await req(port, { path: "/api/remote/push/key" })).status, 401)
    assert.equal((await post(port, "/api/remote/push/subscribe", { endpoint: "https://web.push.apple.com/x" })).status, 401)
    const { cookie } = await pairDevice(port, e)
    const key = await req(port, { path: "/api/remote/push/key", headers: { cookie } })
    assert.equal(Buffer.from(key.json.publicKey, "base64url").length, 65)
    assert.equal((await post(port, "/api/remote/push/subscribe", { endpoint: "https://evil.example/x" }, { cookie })).status, 400)
    assert.equal((await post(port, "/api/remote/push/subscribe", { endpoint: "https://web.push.apple.com/x" }, { cookie })).status, 200)

    await new Promise((r) => setTimeout(r, 150))
    writePending(e.remoteDir, { promptId: newPromptId(), harness: "claude-code", sessionId: "s9", kind: "permission", tool: "Bash", target: "npm test", askedAt: new Date().toISOString(), pid: process.pid })
    await new Promise((r) => setTimeout(r, 300))
    assert.equal(pings.length, 1)
    assert.equal(pings[0].url, "https://web.push.apple.com/x")
    assert.equal(pings[0].init.body, undefined)

    assert.equal((await post(port, "/api/remote/push/unsubscribe", {}, { cookie })).status, 200)
    writePending(e.remoteDir, { promptId: newPromptId(), harness: "claude-code", sessionId: "s10", kind: "permission", tool: "Bash", target: "ls", askedAt: new Date().toISOString(), pid: process.pid })
    await new Promise((r) => setTimeout(r, 300))
    assert.equal(pings.length, 1)
  } finally { await srv.close() }
})

test("notifications: with pushOnNewPrompt off (the dashboard's dispatcher decides) a new prompt pings no phone", async () => {
  const e = env()
  const pings = []
  const srv = await createRemoteServer({ port: 0, host: HOST, ...e, needsYou: async () => [], heartbeatMs: 200, scanMs: 50, pushOnNewPrompt: false, pushFetch: async (url) => { pings.push(url); return { status: 201 } } })
  try {
    const { cookie } = await pairDevice(srv.port, e)
    assert.equal((await post(srv.port, "/api/remote/push/subscribe", { endpoint: "https://web.push.apple.com/x" }, { cookie })).status, 200)
    await new Promise((r) => setTimeout(r, 150))
    writePending(e.remoteDir, { promptId: newPromptId(), harness: "claude-code", sessionId: "s11", kind: "permission", tool: "Bash", target: "npm test", askedAt: new Date().toISOString(), pid: process.pid })
    await new Promise((r) => setTimeout(r, 300))
    assert.deepEqual(pings, [])
  } finally { await srv.close() }
})
