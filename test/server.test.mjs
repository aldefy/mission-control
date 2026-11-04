import { test } from "node:test"
import assert from "node:assert/strict"
import { mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createServer } from "../src/server.mjs"

const adapter = { name: "stub", listRuns: async () => [], getRun: async () => null, getSession: async () => null }

async function withServer(fn) {
  const distDir = mkdtempSync(join(tmpdir(), "mc-dist-"))
  writeFileSync(join(distDir, "index.html"), "<h1>ok</h1>")
  const srv = await createServer(adapter, { port: 0, distDir })
  try {
    await fn(`http://127.0.0.1:${srv.port}`)
  } finally {
    await srv.close()
  }
}

test("serves index and capabilities on loopback", async () => {
  await withServer(async (base) => {
    assert.match(await (await fetch(`${base}/`)).text(), /ok/)
    const res = await fetch(`${base}/api/capabilities`)
    assert.deepEqual(await res.json(), { adapter: "stub", extras: [], actions: [], source: null })
  })
})

test("unknown route is 404 json", async () => {
  await withServer(async (base) => {
    const res = await fetch(`${base}/api/nope`)
    assert.equal(res.status, 404)
    assert.deepEqual(await res.json(), { error: "not found" })
  })
})

test("capabilities exposes the adapter source from describe()", async () => {
  const distDir = mkdtempSync(join(tmpdir(), "mc-dist-"))
  const srv = await createServer({ ...adapter, describe: () => ({ source: "/some/runs" }) }, { port: 0, distDir })
  try {
    const caps = await (await fetch(`http://127.0.0.1:${srv.port}/api/capabilities`)).json()
    assert.equal(caps.source, "/some/runs")
  } finally {
    await srv.close()
  }
})

// Raw request with chosen headers (fetch forbids setting Host).
import { request } from "node:http"
function raw(port, { method = "GET", path = "/api/runs", headers = {}, body } = {}) {
  return new Promise((done, fail) => {
    const req = request({ host: "127.0.0.1", port, method, path, headers, setHost: !("host" in headers) }, (res) => {
      let text = ""
      res.on("data", (c) => (text += c))
      res.on("end", () => done({ status: res.statusCode, headers: res.headers, text }))
    })
    req.on("error", fail)
    req.end(body)
  })
}
async function withPort(a, fn) {
  const distDir = mkdtempSync(join(tmpdir(), "mc-dist-"))
  writeFileSync(join(distDir, "index.html"), "<h1>ok</h1>")
  const srv = await createServer(a, { port: 0, distDir })
  try { await fn(srv.port) } finally { await srv.close() }
}
const acting = { ...adapter, actions: { say: async (id, body) => ({ id, body }) } }

test("C1: a request whose Host is not loopback on our port is refused 403", async () => {
  await withPort(acting, async (port) => {
    for (const host of ["evil.example", `evil.example:${port}`, `localhost:${port + 1}`, "localhost", `127.0.0.2:${port}`]) {
      const r = await raw(port, { headers: { host } })
      assert.equal(r.status, 403, host)
      assert.deepEqual(JSON.parse(r.text), { error: "host not allowed" })
    }
    for (const host of [`localhost:${port}`, `127.0.0.1:${port}`, `[::1]:${port}`]) {
      assert.equal((await raw(port, { headers: { host } })).status, 200, host)
    }
    assert.equal((await raw(port, { path: "/", headers: { host: "evil.example" } })).status, 403)
  })
})

test("C1: POST needs application/json (415) and a same-port loopback Origin when one is sent (403)", async () => {
  await withPort(acting, async (port) => {
    const path = "/api/run/r1/action/say"
    const host = `localhost:${port}`
    const noType = await raw(port, { method: "POST", path, headers: { host }, body: "{}" })
    assert.equal(noType.status, 415)
    const form = await raw(port, { method: "POST", path, headers: { host, "content-type": "text/plain" }, body: "{}" })
    assert.equal(form.status, 415)
    for (const origin of ["http://evil.example", `http://localhost:${port + 1}`, "null", `https://localhost:${port}`]) {
      const r = await raw(port, { method: "POST", path, headers: { host, origin, "content-type": "application/json" }, body: "{}" })
      assert.equal(r.status, 403, origin)
      assert.deepEqual(JSON.parse(r.text), { error: "cross-origin request refused" })
    }
    for (const origin of [undefined, `http://localhost:${port}`, `http://127.0.0.1:${port}`, `http://[::1]:${port}`]) {
      const headers = { host, "content-type": "application/json; charset=utf-8", ...(origin ? { origin } : {}) }
      const ok = await raw(port, { method: "POST", path, headers, body: '{"t":1}' })
      assert.equal(ok.status, 200, String(origin))
      assert.deepEqual(JSON.parse(ok.text), { id: "r1", body: { t: 1 } })
    }
  })
})

test("M2: non-JSON extras responses carry nosniff", async () => {
  const a = { ...adapter, extras: { raw: async () => ({ type: "text/plain; charset=utf-8", body: "hi" }) } }
  await withPort(a, async (port) => {
    const r = await raw(port, { path: "/api/x/raw/r1" })
    assert.equal(r.status, 200)
    assert.equal(r.headers["x-content-type-options"], "nosniff")
  })
})

test("C2: a missing dist/index.html logs one stderr line and the API still serves", async () => {
  const distDir = mkdtempSync(join(tmpdir(), "mc-nodist-"))
  const errs = []
  const orig = console.error
  console.error = (...a) => errs.push(a.join(" "))
  let srv
  try { srv = await createServer(adapter, { port: 0, distDir }) } finally { console.error = orig }
  try {
    assert.deepEqual(errs, [`mission control: no built page at ${join(distDir, "index.html")} — run npm run build`])
    const r = await raw(srv.port, { path: "/api/runs" })
    assert.equal(r.status, 200)
  } finally { await srv.close() }
})

test("M4: a failed ::1 listener is logged, not fatal", async () => {
  const { createServer: net } = await import("node:net")
  const blocker = net()
  const ok = await new Promise((r) => { blocker.once("error", () => r(false)); blocker.listen(0, "::1", () => r(true)) })
  if (!ok) return // no IPv6 loopback here
  const port = blocker.address().port
  const errs = []
  const orig = console.error
  console.error = (...a) => errs.push(a.join(" "))
  const distDir = mkdtempSync(join(tmpdir(), "mc-dist-"))
  writeFileSync(join(distDir, "index.html"), "<h1>ok</h1>")
  let srv
  try {
    srv = await createServer(adapter, { port, distDir })
    await new Promise((r) => setTimeout(r, 50))
  } finally { console.error = orig; blocker.close() }
  try {
    assert.deepEqual(errs, ["mission control: ::1 listener failed: EADDRINUSE"])
    assert.equal((await raw(srv.port, { headers: { host: `localhost:${port}` } })).status, 200)
  } finally { await srv.close() }
})

// ---- v2.3 remote answering on :4319 (T12, C9, C19, C38, C47) ----
import { mkdirSync as mkdirV23, readFileSync as readV23, existsSync as existsV23 } from "node:fs"
import { createPairingToken as pairTokenV23, redeemToken as redeemV23 } from "../src/remote/pairing.mjs"

async function withRemoteServer(fn, { config } = {}) {
  const home = mkdtempSync(join(tmpdir(), "mc-home-"))
  const mc = join(home, ".mission-control")
  mkdirV23(join(mc, "hooks"), { recursive: true })
  const configPath = join(mc, "config.json")
  if (config) writeFileSync(configPath, JSON.stringify(config))
  const distDir = mkdtempSync(join(tmpdir(), "mc-dist-"))
  writeFileSync(join(distDir, "index.html"), "<h1>ok</h1>")
  const remoteDir = join(mc, "remote")
  const srv = await createServer(adapter, { port: 0, distDir, config: configPath, remote: { home, remoteDir, hooksDir: join(mc, "hooks"), log: () => {} } })
  await srv.remote.start()
  try { await fn(srv.port, { home, remoteDir, configPath, srv }) } finally { await srv.close() }
}
const loop = (port) => ({ host: `127.0.0.1:${port}`, origin: `http://127.0.0.1:${port}`, "content-type": "application/json" })

test("v2.3: fresh home -> remote off, no second listener; status has exactly the C19 keys and no secret material", async () => {
  await withRemoteServer(async (port, { remoteDir, srv }) => {
    assert.equal(srv.remote.port(), null, "no second socket")
    redeemV23({ remoteDir, token: pairTokenV23({ remoteDir, host: "a.ts.net" }).token, ua: "iPhone Safari" })
    pairTokenV23({ remoteDir, host: "a.ts.net" })
    const r = await raw(port, { path: "/api/remote/status", headers: { host: `127.0.0.1:${port}` } })
    assert.equal(r.status, 200)
    const st = JSON.parse(r.text)
    assert.deepEqual(Object.keys(st).sort(), ["devices", "enabled", "host", "pairing", "remotePort", "waitSeconds"])
    assert.deepEqual([st.enabled, st.host, st.remotePort, st.waitSeconds, st.pairing.open], [false, null, 4330, 120, true])
    assert.deepEqual(Object.keys(st.devices[0]).sort(), ["id", "label", "lastSeenAt", "pairedAt"])
    assert.ok(!/token|secret|hash/i.test(r.text))
    assert.equal((await raw(port, { path: "/api/remote/status", headers: { host: `127.0.0.1:${port}`, origin: "http://evil.example" } })).status, 403)
  })
})

test("v2.3: :4319 serves no answering or pairing route: each is 404", async () => {
  await withRemoteServer(async (port) => {
    const h = loop(port)
    for (const [method, path] of [["POST", "/api/remote/pair"], ["POST", "/api/remote/answer"], ["GET", "/api/remote/prompts"], ["GET", "/api/remote/events"], ["GET", "/api/remote/me"], ["GET", "/api/remote/enabled"], ["OPTIONS", "/api/remote/enabled"], ["POST", "/api/remote/devices"], ["POST", "/api/remote/revoke"], ["POST", "/api/remote/status"], ["GET", "/api/remote"]]) {
      const r = await raw(port, { method, path, headers: h, body: method === "POST" ? "{}" : undefined })
      assert.equal(r.status, 404, `${method} ${path}`)
    }
  })
  // and without a remote control at all (embedders, older tests): status is read-only defaults, enabled 404
  await withServer(async (base) => {
    const st = await (await fetch(`${base}/api/remote/status`)).json()
    assert.equal(st.enabled, false)
    assert.equal((await fetch(`${base}/api/remote/enabled`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" })).status, 404)
  })
})

test("v2.3: POST /api/remote/enabled guards in order: Host 403, Origin missing/foreign 403, non-JSON 415, bad body 400, invalid config 422", async () => {
  await withRemoteServer(async (port, { home, configPath }) => {
    const p = "/api/remote/enabled"
    const body = JSON.stringify({ enabled: true })
    assert.equal((await raw(port, { method: "POST", path: p, body, headers: { ...loop(port), host: "evil.example" } })).status, 403)
    assert.equal((await raw(port, { method: "POST", path: p, body, headers: { host: `127.0.0.1:${port}`, "content-type": "application/json" } })).status, 403, "no Origin")
    assert.equal((await raw(port, { method: "POST", path: p, body, headers: { ...loop(port), origin: "http://evil.example" } })).status, 403)
    assert.equal((await raw(port, { method: "POST", path: p, body, headers: { ...loop(port), origin: `http://localhost:${port}` } })).status, 403, "Origin must match the request Host")
    assert.equal((await raw(port, { method: "POST", path: p, body, headers: { ...loop(port), "content-type": "text/plain" } })).status, 415)
    for (const b of ['{"enabled":"yes"}', '{"enabled":true,"x":1}', "[]", "{bad"]) assert.equal((await raw(port, { method: "POST", path: p, body: b, headers: loop(port) })).status, 400, b)
    const r = await raw(port, { method: "POST", path: p, body, headers: loop(port) })
    assert.equal(r.status, 422)
    assert.equal(JSON.parse(r.text).key, "remote.host")
    assert.equal(JSON.parse((await raw(port, { path: "/api/remote/status", headers: { host: `127.0.0.1:${port}` } })).text).enabled, false)
    assert.equal(existsV23(join(home, ".mission-control", "audit.jsonl")), false)
    assert.equal(existsV23(configPath), false, "nothing persisted")
    const off = await raw(port, { method: "POST", path: p, body: '{"enabled":false}', headers: loop(port) })
    assert.deepEqual([off.status, JSON.parse(off.text).enabled], [200, false], "a no-op is 200")
  })
})

test("v2.3: POST /api/remote/enabled on and off with a valid config", async () => {
  const { createServer: netServer } = await import("node:net")
  const rp = await new Promise((ok) => { const s = netServer(); s.listen(0, "127.0.0.1", () => { const x = s.address().port; s.close(() => ok(x)) }) })
  await withRemoteServer(async (port, { home, srv }) => {
    const on = await raw(port, { method: "POST", path: "/api/remote/enabled", body: '{"enabled":true}', headers: loop(port) })
    assert.equal(on.status, 200, on.text)
    assert.deepEqual([JSON.parse(on.text).enabled, srv.remote.port()], [true, rp])
    const off = await raw(port, { method: "POST", path: "/api/remote/enabled", body: '{"enabled":false}', headers: loop(port) })
    assert.equal(JSON.parse(off.text).enabled, false)
    const lines = readV23(join(home, ".mission-control", "audit.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l))
    assert.deepEqual(lines.map((l) => [l.actor, l.action]), [["dashboard", "remote-on"], ["dashboard", "remote-off"]])
  }, { config: { remote: { host: "laptop.tail1234.ts.net", port: rp } } })
})

test("every dashboard response forbids framing and sniffing (clickjacking)", async () => {
  const { mkdtempSync: mk, writeFileSync: wf } = await import("node:fs")
  const { tmpdir: td } = await import("node:os")
  const { join: jn } = await import("node:path")
  const { createServer: cs } = await import("../src/server.mjs")
  const dist = mk(jn(td(), "mc-dist-"))
  wf(jn(dist, "index.html"), "<h1>ok</h1>")
  const src = { name: "cc", harness: "claude-code", listItems: async () => [], getItem: async () => null, getCalls: async () => [], getSession: async () => null }
  const srv = await cs(src, { port: 0, distDir: dist })
  try {
    for (const path of ["/", "/api/items", "/nope"]) {
      const r = await fetch(`http://127.0.0.1:${srv.port}${path}`)
      assert.equal(r.headers.get("x-frame-options"), "DENY", path)
      assert.match(r.headers.get("content-security-policy") ?? "", /frame-ancestors 'none'/, path)
      assert.equal(r.headers.get("x-content-type-options"), "nosniff", path)
    }
    // fetch drops a custom Host header, so ask with http.request: a refused host gets the headers too.
    const { request } = await import("node:http")
    const foreign = await new Promise((done, fail) => request({ host: "127.0.0.1", port: srv.port, path: "/", headers: { host: "evil.example" } }, (r) => { r.resume(); done(r) }).on("error", fail).end())
    assert.equal(foreign.statusCode, 403)
    assert.equal(foreign.headers["x-frame-options"], "DENY")
  } finally { await srv.close() }
})
