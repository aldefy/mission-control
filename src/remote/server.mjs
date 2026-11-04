// The remote listener and its runtime on/off control (spec FR-3–FR-15, contract C5, C7, C11–C19, C36–C43).
// The listener is a second HTTP server on 127.0.0.1 only, meant to sit behind `tailscale serve`. It serves
// the phone page and /api/remote/{pair,me,prompts,events,answer}; nothing from the dashboard API.
import { createServer as createHttpServer } from "node:http"
import { readdirSync } from "node:fs"
import { readFile, realpath } from "node:fs/promises"
import { join, resolve, sep } from "node:path"
import { ANSWER_REASONS, ERRORS, HEARTBEAT_SECONDS, SERVER_HEARTBEAT_MS } from "./contract.mjs"
import { appendAudit, appendToggle } from "./audit.mjs"
import { createChangeFeed } from "../events.mjs"
import { createNewPromptWatch, loadVapid, ping, readSubscriptions, setSubscription, validSubscription } from "./push.mjs"
import { clearCookieHeader, createPairLimiter, listDevices, pairingStatus, redeemToken, verifyDevice } from "./pairing.mjs"
import { abandonAll, abandonAnswered, decide, isPromptId, joinEntries, listPending, pendingDir } from "./prompts.mjs"
import { ensureDir, isPidAlive, readConfigFile, readJson, readRemoteConfig, remoteFromConfig, removeFile, startHeartbeat, validateRemote, writeJsonAtomic, writeRemoteEnabled } from "./state.mjs"

const MAX_BODY = 64 * 1024
const REASON_TEXT = { changed: "prompt changed", answered: "already answered", terminal: "answered in terminal", gone: "no longer waiting" }
const SECURITY_HEADERS = {
  "x-content-type-options": "nosniff",
  "referrer-policy": "no-referrer",
  // Nobody may frame the answer buttons (clickjacking).
  "x-frame-options": "DENY",
  "content-security-policy": "frame-ancestors 'none'",
}

function send(res, status, body, headers = {}) {
  const text = JSON.stringify(body)
  res.writeHead(status, { ...SECURITY_HEADERS, "content-type": "application/json; charset=utf-8", "cache-control": "no-store", ...headers })
  res.end(res.req?.method === "HEAD" ? undefined : text)
}

async function readJsonBody(req) {
  const chunks = []
  let size = 0
  for await (const c of req) {
    size += c.length
    if (size > MAX_BODY) throw { status: 413, message: "body too large" }
    chunks.push(c)
  }
  try { return JSON.parse(Buffer.concat(chunks).toString("utf8")) } catch { throw { status: 400, message: "bad json" } }
}

const STATIC_TYPES = {
  ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8", ".png": "image/png", ".svg": "image/svg+xml",
  ".woff2": "font/woff2", ".woff": "font/woff", ".json": "application/json; charset=utf-8", ".ico": "image/x-icon", ".webp": "image/webp",
}

/** A file under distDir, confined by realpath; null when missing or outside. */
async function readConfined(distDir, rel) {
  const root = resolve(distDir)
  const target = resolve(root, "." + rel)
  if (!target.startsWith(root + sep)) return null
  try {
    const real = await realpath(target)
    if (!real.startsWith((await realpath(root)) + sep)) return null
    return { body: await readFile(real), real }
  } catch { return null }
}

/** The C5 static allow-list: path -> [file under dist, content type, extra headers]. */
async function serveShell(res, distDir, pathname) {
  let rel = null, type = null, extra = {}
  if (pathname === "/" || pathname === "/pair") { rel = "/remote.html"; type = "text/html; charset=utf-8"; extra = { "cache-control": "no-cache" } }
  else if (pathname === "/manifest.webmanifest") { rel = pathname; type = "application/manifest+json" }
  else if (pathname === "/sw.js") { rel = pathname; type = "text/javascript"; extra = { "cache-control": "no-cache" } }
  else if (/^\/(icons|assets)\/[^/]+$/.test(pathname)) {
    let name
    try { name = decodeURIComponent(pathname) } catch { return false }
    if (name.includes("\0") || /\/\.\.?($|\/)/.test(name)) return false
    rel = name
    const ext = name.slice(name.lastIndexOf("."))
    type = STATIC_TYPES[ext]
    if (!type) return false
  } else return false
  const f = await readConfined(distDir, rel)
  if (!f) return false
  res.writeHead(200, { ...SECURITY_HEADERS, "content-type": type, ...extra })
  res.end(res.req.method === "HEAD" ? undefined : f.body)
  return true
}

/**
 * Open the remote listener on 127.0.0.1:`port` for `host` (a *.ts.net name). Resolves with
 * { port, close(), changed(), clients } once listening; rejects when the port cannot be bound.
 * `ctx`: { remoteDir, hooksDir, home, distDir, needsYou(), watchDirs(), seen(deviceId), known, now, isAlive }.
 */
export function createRemoteServer({ port, host, ...ctx }) {
  const { remoteDir, hooksDir, home, distDir, needsYou, watchDirs = () => [], now = () => Date.now(), isAlive = isPidAlive, seen = () => {}, known = new Map(), heartbeatMs = HEARTBEAT_SECONDS * 1000 - 500, scanMs = 1000, pushFetch = globalThis.fetch, pushOnNewPrompt = true } = ctx
  const hosts = new Set([host, `${host}:443`])
  const origin = `https://${host}`
  const limiter = ctx.limiter ?? createPairLimiter({ now })
  const clients = new Map() // res -> device id
  ensureDir(pendingDir(remoteDir))

  const push = (event) => {
    for (const [r, id] of clients) {
      try { r.write(`event: ${event}\ndata: {}\n\n`) } catch { drop(r) }
      if (event === "heartbeat" && verifyDevice({ remoteDir, cookie: { id, secret: r.mcSecret } }) === "revoked") drop(r)
    }
  }
  const drop = (r) => {
    clients.delete(r)
    try { r.destroy() } catch { /* gone */ }
    if (!clients.size) feed.stop()
  }
  const feed = createChangeFeed({ targets: () => ({ dirs: [...watchDirs(), pendingDir(remoteDir)] }), pollMs: 1000, onChange: () => push("changed") })
  const beat = setInterval(() => push("heartbeat"), heartbeatMs)
  beat.unref?.()
  // Outcome B: a prompt answered in the terminal gets an abandon, so its hook exits at once.
  // A new prompt pings subscribed phones (Web Push, no payload), once per prompt; off when the dashboard's
  // notification dispatcher decides which channel gets each prompt (pushOnNewPrompt: false).
  const pings = pushOnNewPrompt ? createNewPromptWatch(() => {
    ping({ remoteDir, deviceIds: listDevices({ remoteDir }).map((d) => d.id), fetch: pushFetch, now }).catch(() => {})
  }) : null
  const scan = setInterval(() => {
    try { if (abandonAnswered({ remoteDir, hooksDir, now: now(), isAlive }) > 0) push("changed") } catch { /* next scan */ }
    if (pings) try { pings(listPending({ remoteDir, hooksDir, isAlive }).map((p) => p.promptId)) } catch { /* next scan */ }
  }, scanMs)
  scan.unref?.()

  /** The paired device for a cookie route, or null after sending the 401. */
  function auth(req, res) {
    const d = verifyDevice({ remoteDir, cookie: req.headers.cookie })
    if (d === "revoked") { send(res, 401, { error: ERRORS.revoked }, { "set-cookie": clearCookieHeader() }); return null }
    if (!d) { send(res, 401, { error: ERRORS.notPaired }); return null }
    seen(d.id)
    return d
  }

  async function prompts() {
    const pend = listPending({ remoteDir, hooksDir, isAlive })
    let nys = []
    try { nys = (await needsYou?.()) ?? [] } catch { nys = [] }
    const entries = joinEntries(nys, pend)
    for (const p of pend) known.set(p.promptId, { harness: p.harness, sessionId: p.sessionId, callId: p.callId })
    while (known.size > 1000) known.delete(known.keys().next().value)
    return entries
  }

  async function handle(req, res, url) {
    const path = url.pathname
    const get = req.method === "GET" || req.method === "HEAD"
    if (req.method === "POST" && path === "/api/remote/pair") {
      if (limiter.blocked()) return send(res, 429, { error: ERRORS.tooManyAttempts })
      const body = await readJsonBody(req)
      if (!body || typeof body !== "object" || Array.isArray(body) || typeof body.token !== "string" || Object.keys(body).length !== 1) return send(res, 400, { error: "body must be {token}" })
      const r = redeemToken({ remoteDir, token: body.token, ua: req.headers["user-agent"], now: now() })
      if (!r) { limiter.fail(); return send(res, 401, { error: ERRORS.pairingInvalid }) }
      seen(r.device.id)
      return send(res, 200, { device: r.device }, { "set-cookie": r.cookie })
    }
    if (get && path === "/api/remote/me") {
      const d = auth(req, res)
      return d && send(res, 200, { device: { id: d.id, label: d.label } })
    }
    // Notifications (opt-in per device): the VAPID public key, then the browser's subscription.
    if (get && path === "/api/remote/push/key") {
      const d = auth(req, res)
      return d && send(res, 200, { publicKey: loadVapid(remoteDir).publicKey })
    }
    if (req.method === "POST" && (path === "/api/remote/push/subscribe" || path === "/api/remote/push/unsubscribe")) {
      const d = auth(req, res)
      if (!d) return
      if (path.endsWith("/unsubscribe")) { setSubscription(remoteDir, d.id, null, now()); return send(res, 200, { ok: true }) }
      const sub = validSubscription(await readJsonBody(req))
      if (!sub) return send(res, 400, { error: "not a push subscription from a known push service" })
      setSubscription(remoteDir, d.id, sub, now())
      return send(res, 200, { ok: true })
    }
    if (get && path === "/api/remote/prompts") {
      const d = auth(req, res)
      return d && send(res, 200, { prompts: await prompts() })
    }
    if (get && path === "/api/remote/events") {
      const d = auth(req, res)
      if (!d) return
      if (req.method === "HEAD") return send(res, 200, {})
      res.writeHead(200, { ...SECURITY_HEADERS, "content-type": "text/event-stream; charset=utf-8", "cache-control": "no-store", connection: "keep-alive", "x-accel-buffering": "no" })
      res.write("retry: 2000\nevent: heartbeat\ndata: {}\n\n")
      res.mcSecret = req.headers.cookie ? (/(?:^|;\s*)__Host-mc_device=[^.;]+\.([^;\s]+)/.exec(req.headers.cookie)?.[1] ?? "") : ""
      clients.set(res, d.id)
      feed.start()
      res.on("error", () => drop(res))
      req.on("close", () => { clients.delete(res); if (!clients.size) feed.stop() })
      return
    }
    if (req.method === "POST" && path === "/api/remote/answer") {
      const d = auth(req, res)
      if (!d) return
      const body = await readJsonBody(req)
      if (!body || typeof body !== "object" || Array.isArray(body) || typeof body.promptId !== "string" || typeof body.bind !== "string" || !("decision" in body)) return send(res, 400, { error: "body must be {promptId, bind, decision}" })
      if (Object.keys(body).some((k) => k !== "promptId" && k !== "bind" && k !== "decision")) return send(res, 400, { error: "unknown field" })
      if (!isPromptId(body.promptId)) return send(res, 409, { error: REASON_TEXT.gone, reason: "gone" })
      const r = decide({ remoteDir, hooksDir, promptId: body.promptId, bind: body.bind, decision: body.decision, device: d.id, now: now(), isAlive, known })
      if (r.error) return send(res, 400, { error: r.error })
      if (r.reason) return send(res, 409, { error: REASON_TEXT[r.reason], reason: ANSWER_REASONS.includes(r.reason) ? r.reason : "gone" })
      try {
        appendAudit({ home, device: d.id, promptId: r.pending.promptId, decision: body.decision, tool: r.pending.tool, target: r.pending.target, questions: r.pending.questions, now: now() })
      } catch (e) { console.error(`mission control: audit write failed: ${e?.message ?? e}`) }
      push("changed")
      return send(res, 200, { ok: true })
    }
    if (get && (await serveShell(res, distDir, path))) return
    return send(res, 404, { error: "not found" })
  }

  const handler = async (req, res) => {
    // Only the configured tailnet name (Serve passes it through) and only that origin.
    if (!hosts.has(req.headers.host)) return send(res, 403, { error: "host not allowed" })
    const o = req.headers.origin
    if (o !== undefined && o !== origin) return send(res, 403, { error: "cross-origin request refused" })
    if (req.method === "POST") {
      if (o === undefined) return send(res, 403, { error: "origin required" })
      const type = String(req.headers["content-type"] ?? "").split(";")[0].trim().toLowerCase()
      if (type !== "application/json") return send(res, 415, { error: "content-type must be application/json" })
    } else if (req.method !== "GET" && req.method !== "HEAD") return send(res, 404, { error: "not found" })
    try {
      await handle(req, res, new URL(req.url, "http://remote.invalid"))
    } catch (e) {
      if (res.headersSent) { try { res.destroy() } catch { /* gone */ } return }
      if (Number.isInteger(e?.status)) return send(res, e.status, { error: e.message })
      send(res, 500, { error: "internal error" })
    }
  }

  return new Promise((ok, fail) => {
    const srv = createHttpServer(handler)
    srv.once("error", fail)
    srv.listen(port, "127.0.0.1", () => {
      srv.off("error", fail)
      srv.on("error", (e) => console.error(`mission control: remote listener: ${e?.message ?? e}`))
      ok({
        port: srv.address().port,
        clients: () => clients.size,
        changed: () => push("changed"),
        close: () => new Promise((done) => {
          clearInterval(beat); clearInterval(scan); feed.stop()
          for (const r of clients.keys()) { try { r.destroy() } catch { /* gone */ } }
          clients.clear()
          srv.close(() => done())
          srv.closeAllConnections?.()
        }),
      })
    })
  })
}

const CONTROL_FILE = /^([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.json$/

/**
 * Remote answering for one dashboard process (C36–C43): the effective config (flags over config.json over
 * defaults), the listener's lifecycle, server.json, the CLI control files and the status the dashboard
 * shows. `dashboardPort()` gives the :4319 listener's actual port.
 */
export function createRemoteControl({ home, remoteDir, hooksDir, configPath, dashboardPort, flags = null, distDir, needsYou, watchDirs, now = () => Date.now(), log = (s) => console.log(s), isAlive = isPidAlive, heartbeatMs = SERVER_HEARTBEAT_MS, controlMs = 250, scanMs, eventsHeartbeatMs, pushOnNewPrompt = true, pushFetch }) {
  let listener = null
  let queue = Promise.resolve()
  const lastSeen = new Map()
  const known = new Map()
  const limiter = createPairLimiter({ now })
  const startedAt = new Date(now()).toISOString()
  let hb = null, control = null

  function effective(config) {
    const c = config ? remoteFromConfig(config) : readRemoteConfig(configPath)
    return { host: flags?.host ?? c.host, port: flags?.port ?? c.port, waitSeconds: c.waitSeconds }
  }

  function status() {
    const eff = effective()
    return {
      enabled: !!listener,
      host: eff.host ?? null,
      remotePort: Number.isInteger(eff.port) ? eff.port : null,
      waitSeconds: eff.waitSeconds,
      devices: listDevices({ remoteDir }).map((d) => ({ id: d.id, label: d.label, pairedAt: d.pairedAt, lastSeenAt: lastSeen.get(d.id) ?? null })),
      pairing: pairingStatus({ remoteDir, now: now() }),
    }
  }

  const serverInfo = () => {
    const eff = effective()
    return {
      pid: process.pid, port: dashboardPort(),
      remotePort: listener ? listener.port : null, host: listener ? listener.host : null,
      waitSeconds: eff.waitSeconds, enabled: !!listener, startedAt,
    }
  }
  const publish = () => { try { writeJsonAtomic(join(remoteDir, "server.json"), serverInfo()) } catch { /* heartbeat retries */ } }

  async function open(eff) {
    const l = await createRemoteServer({
      port: eff.port, host: eff.host, remoteDir, hooksDir, home, distDir, needsYou, watchDirs, now, isAlive, known, limiter, pushOnNewPrompt,
      ...(pushFetch ? { pushFetch } : {}),
      seen: (id) => lastSeen.set(id, new Date(now()).toISOString()),
      ...(scanMs ? { scanMs } : {}), ...(eventsHeartbeatMs ? { heartbeatMs: eventsHeartbeatMs } : {}),
    })
    listener = { ...l, host: eff.host }
    publish()
    log(`mission control remote answering on http://127.0.0.1:${l.port} for https://${eff.host}`)
    log(`  expose it on your tailnet only: tailscale serve --bg --https=443 http://127.0.0.1:${l.port}`)
    log("  never use tailscale funnel for this: it would put the answering page on the public internet")
    log(`  hooks wait up to ${eff.waitSeconds}s for a phone answer, then the terminal prompt takes over`)
  }

  async function shut() {
    const l = listener
    if (!l) return
    listener = null
    publish() // 1. enabled:false in server.json: waiting hooks see it on their next poll
    try { abandonAll({ remoteDir, now: now() }) } catch { /* 2. hooks still see enabled:false */ }
    l.changed() // 3. phones refetch (and then find the listener gone)
    await l.close() // 4. close the listener and every socket, SSE included
    log("mission control remote answering off")
  }

  /** Apply an on/off request (C37–C40, C43): { status, body }. Serialized; `actor` is dashboard or cli. */
  function setEnabled(enabled, actor) {
    const run = queue.then(async () => {
      const file = readConfigFile(configPath)
      if (!file.ok) return { status: 422, body: { error: `${configPath} is not valid JSON; fix it first (nothing was changed)`, key: "config.json" } }
      if (enabled === !!listener) return { status: 200, body: status() }
      if (enabled) {
        const eff = effective(file.config)
        const bad = validateRemote({ host: eff.host, port: eff.port, dashboardPort: dashboardPort(), configPath })
        if (bad) return { status: 422, body: bad }
        try { await open(eff) } catch (e) {
          const why = e?.code === "EADDRINUSE" ? "is in use" : e?.code === "EACCES" ? "is not allowed" : `cannot be bound (${e?.code ?? e?.message ?? e})`
          return { status: 422, body: { error: `remote.port ${eff.port} ${why}; pick another in ${configPath ?? "config.json"}`, key: "remote.port" } }
        }
      } else await shut()
      if (configPath) { try { writeRemoteEnabled(configPath, enabled) } catch (e) { console.error(`mission control: could not save remote.enabled: ${e?.message ?? e}`) } }
      try { appendToggle({ home, actor, enabled, now: now() }) } catch (e) { console.error(`mission control: audit write failed: ${e?.message ?? e}`) }
      return { status: 200, body: status() }
    })
    queue = run.catch(() => {})
    return run
  }

  /** CLI requests under remote/control/ (C42): apply each through setEnabled, answer in <id>.result.json. */
  async function pollControl() {
    const dir = join(remoteDir, "control")
    let names
    try { names = readdirSync(dir) } catch { return }
    for (const n of names) {
      const m = CONTROL_FILE.exec(n)
      if (!m) continue
      const path = join(dir, n)
      const req = readJson(path)
      removeFile(path)
      const result = join(dir, `${m[1]}.result.json`)
      if (!req || typeof req.enabled !== "boolean") { writeJsonAtomic(result, { ok: false, error: "bad control request", key: "config.json" }); continue }
      const r = await setEnabled(req.enabled, "cli")
      writeJsonAtomic(result, r.status === 200 ? { ok: true, status: r.body } : { ok: false, error: r.body.error, key: r.body.key })
    }
  }

  // Phones the dispatcher can ping: remote answering on, and a paired device that turned push on.
  const pushDevices = () => {
    const subs = readSubscriptions(remoteDir)
    return listDevices({ remoteDir }).map((d) => d.id).filter((id) => subs[id])
  }
  return {
    status,
    setEnabled,
    lastSeen,
    push: {
      available: () => !!listener && pushDevices().length > 0,
      ping: () => ping({ remoteDir, deviceIds: listDevices({ remoteDir }).map((d) => d.id), ...(pushFetch ? { fetch: pushFetch } : {}), now }).catch(() => 0),
    },
    isOn: () => !!listener,
    port: () => listener?.port ?? null,
    /**
     * Publish server.json, start the heartbeat and the control poller, then apply the start state: on for
     * this run with flags, else per remote.enabled. Resolves { ok: true } or { ok: false, error, key }.
     * Starting never persists config and never writes an audit line.
     */
    async start() {
      ensureDir(remoteDir)
      hb = startHeartbeat(remoteDir, serverInfo, { everyMs: heartbeatMs })
      let busy = false
      control = setInterval(() => {
        if (busy) return
        busy = true
        pollControl().finally(() => { busy = false })
      }, controlMs)
      control.unref?.()
      const file = readConfigFile(configPath)
      const want = !!flags || (file.ok && remoteFromConfig(file.config).enabled)
      if (!want) return { ok: true }
      const eff = effective(file.ok ? file.config : {})
      const bad = validateRemote({ host: eff.host, port: eff.port, dashboardPort: dashboardPort(), configPath: flags ? null : configPath })
      if (bad) return { ok: false, ...bad }
      try { await open(eff) } catch (e) {
        return { ok: false, error: `${flags ? "--remote-port" : "remote.port"} ${eff.port} ${e?.code === "EADDRINUSE" ? "is in use" : `cannot be bound (${e?.code ?? e?.message})`}`, key: "remote.port" }
      }
      return { ok: true }
    },
    /** Clean shutdown: close the listener (abandoning waits) and remove server.json. */
    async close() {
      clearInterval(control)
      await shut().catch(() => {})
      hb?.stop({ remove: true })
    },
    /** Synchronous last-chance cleanup for signal handlers. */
    closeSync() {
      clearInterval(control)
      try { if (listener) abandonAll({ remoteDir, now: now() }) } catch { /* best effort */ }
      hb?.stop({ remove: true })
    },
  }
}

/** Status for a dashboard without a remote control (tests, embedders): off, defaults, devices from disk. */
export function staticStatus({ remoteDir = null, configPath = null, now = Date.now() } = {}) {
  const c = readRemoteConfig(configPath)
  return {
    enabled: false, host: c.host, remotePort: Number.isInteger(c.port) ? c.port : null, waitSeconds: c.waitSeconds,
    devices: listDevices({ remoteDir }).map((d) => ({ ...d, lastSeenAt: null })),
    pairing: pairingStatus({ remoteDir, now }),
  }
}

