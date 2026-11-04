import { createServer as createHttpServer } from "node:http"
import { appendFileSync, existsSync, mkdirSync, renameSync, statSync } from "node:fs"
import { readFile, realpath } from "node:fs/promises"
import { dirname, extname, join, resolve, sep } from "node:path"
import { fileURLToPath } from "node:url"
import { isRunId, isSessionName } from "./names.mjs"
import { crewStats } from "./crew.mjs"
import { fromAdapter } from "./sources/from-adapter.mjs"
import { createHash } from "node:crypto"
import { buildTree, NO_PROJECT_INFO, projectsOf, shapeTree } from "./projects.mjs"
import { createHide, isNoise } from "./hidden.mjs"
import { aggregate, defaultTz, isBy, isTz } from "./usage.mjs"
import { createRegistry } from "./sources/registry.mjs"
import { createLoopConfig } from "./loops.mjs"
import { createChangeFeed } from "./events.mjs"
import { apiV22 } from "./api-v22.mjs"
import { createBudgets } from "./budgets.mjs"
import { createWindowConfig } from "./forecast.mjs"
import { createRemoteControl, staticStatus } from "./remote/server.mjs"
import { createTitles } from "./titles.mjs"
import { createMarks } from "./marks.mjs"
import { createSettings } from "./settings.mjs"
import { createDispatcher, macNotify, startNotifier } from "./notify.mjs"

const DEFAULT_DIST = join(dirname(fileURLToPath(import.meta.url)), "..", "dist")

const TYPES = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".woff2": "font/woff2",
  ".woff": "font/woff",
  ".map": "application/json; charset=utf-8",
}

/**
 * A 200 answer to a GET carries a weak ETag; a request whose If-None-Match names it gets 304 and no
 * body, so a poll of an unchanged tree costs a hash, not a transfer. Still no-store: the page sends
 * If-None-Match itself and keeps its own copy.
 */
export function json(res, body, status = 200) {
  const text = JSON.stringify(body)
  const headers = { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" }
  const req = res.req
  if (status === 200 && req && (req.method === "GET" || req.method === "HEAD")) {
    const tag = `W/"${createHash("sha1").update(text).digest("hex").slice(0, 20)}"`
    headers.etag = tag
    if (String(req.headers["if-none-match"] ?? "").split(/\s*,\s*/).includes(tag)) {
      res.writeHead(304, { etag: tag, "cache-control": "no-store" })
      return res.end()
    }
  }
  res.writeHead(status, headers)
  res.end(text)
}

async function serveStatic(res, distDir, pathname) {
  let rel
  try {
    rel = decodeURIComponent(pathname)
  } catch {
    return json(res, { error: "bad request" }, 400)
  }
  if (rel.includes("\0")) return json(res, { error: "bad request" }, 400)
  const root = resolve(distDir)
  const target = resolve(root, "." + (rel === "/" ? "/index.html" : rel))
  if (target !== root && !target.startsWith(root + sep)) return json(res, { error: "bad request" }, 400)
  try {
    const real = await realpath(target)
    const realRoot = await realpath(root)
    if (!real.startsWith(realRoot + sep)) return json(res, { error: "bad request" }, 400)
    const body = await readFile(real)
    res.writeHead(200, { "content-type": TYPES[extname(real)] ?? "application/octet-stream" })
    res.end(body)
  } catch {
    json(res, { error: "not found" }, 404)
  }
}

const notFound = (res) => json(res, { error: "not found" }, 404)
const MAX_BODY = 64 * 1024

export async function readBody(req) {
  const chunks = []
  let size = 0
  for await (const c of req) {
    size += c.length
    if (size > MAX_BODY) throw { status: 413, message: "body too large" }
    chunks.push(c)
  }
  const text = Buffer.concat(chunks).toString("utf8")
  if (!text.trim()) return {}
  try { return JSON.parse(text) } catch { throw { status: 400, message: "bad json" } }
}

// Extras ids are not always run ids (project uses a repo basename such as "my.app").
const isExtrasId = (s) => typeof s === "string" && /^[\w.-]+$/.test(s) && s !== "." && s !== ".."

const decode = (s) => { try { return decodeURIComponent(s) } catch { return null } }

// Source names and item ids: path-safe words only (no separators, no "." or "..").
const isKey = isExtrasId

async function sendExtra(res, r) {
  const status = r.status ?? 200
  if (r.type && !/json/i.test(r.type)) {
    res.writeHead(status, { "content-type": r.type, "cache-control": "no-store", "x-content-type-options": "nosniff" })
    return res.end(r.body)
  }
  return json(res, r.body, status)
}

// v2 routes, one set for every source: /api/overview, /api/items, /api/projects, /api/project/:key, /api/item/:source/:id[/...]
/** `items` with `project` ({ key, name, worktree }) and `hidden` when its project is noise. */
async function place(items, git, hideList) {
  const where = await projectsOf(items.map((i) => i.cwd), { git })
  return items.map((i) => {
    const p = (i.cwd && where.get(i.cwd)) || NO_PROJECT_INFO
    return { ...i, project: { key: p.key, name: p.name, worktree: p.worktree }, ...(isNoise(p, hideList) ? { hidden: true } : {}) }
  })
}

/**
 * The first `limit` items (newest first) that pass `keep`, placed. Items are placed a chunk at a time,
 * so a limit of 100 places about 100 items, not every session on the machine.
 */
async function placeFirst(items, git, hideList, keep, limit = Infinity) {
  if (limit === Infinity) return (await place(items, git, hideList)).filter(keep)
  const out = []
  const chunk = Math.max(limit, 50)
  for (let i = 0; i < items.length && out.length < limit; i += chunk) {
    for (const x of await place(items.slice(i, i + chunk), git, hideList)) if (keep(x) && out.length < limit) out.push(x)
  }
  return out
}

async function apiV2(ctx, req, res, url, parts) {
  const { registry, git, hide, titles, marks, settings, testNotify, pageFailed, pageShown, noteLog, now } = ctx
  const get = req.method === "GET" || req.method === "HEAD"
  const q = url.searchParams
  const all = q.get("all") === "1"
  const tzOf = () => q.get("tz") ?? defaultTz()
  let hideList // read config.json at most once per request
  const hidden = () => (hideList ??= hide.list())
  const isHidden = (p) => isNoise(p, hidden())
  const v22 = await apiV22(ctx, { get, parts: parts.map(decode), isKey, q })
  if (v22) return json(res, v22.body, v22.status ?? 200)
  // What lists, counts and the tree show (ctx.listed): archived items only when asked for (?archived=1).
  const listed = () => ctx.listed({ archived: q.get("archived") === "1" })
  if (req.method === "POST" && parts[0] === "events" && parts[1] === "ack" && parts.length === 2) {
    // The page reports what happened to a notification it was sent: shown, error, failed (with why).
    const b = await readBody(req)
    const str = (v) => String(v ?? "").replace(/[\r\n]+/g, " ").slice(0, 200)
    const result = str(b?.result)
    if (result === "shown") pageShown?.(String(b?.group ?? ""))
    else {
      noteLog(`page ${result}: ${str(b?.group)} (permission ${str(b?.permission)}, tab ${str(b?.visible)})`)
      pageFailed?.(String(b?.group ?? ""))
    }
    return json(res, {})
  }
  if (req.method === "POST" && parts[0] === "settings" && parts[1] === "test" && parts.length === 2) {
    const via = await testNotify({ kind: "test", title: "Test", subtitle: "Mission control", message: "notifications work; a click opens the dashboard", url: "#/", group: "test" })
    return json(res, { via })
  }
  if (parts[0] === "settings" && parts.length === 1) {
    if (get) return json(res, settings.get())
    if (req.method !== "POST") return false
    const body = await readBody(req)
    const keys = Object.keys(body ?? {})
    const ok = (k) => (k === "notifyDismiss" ? Number.isInteger(body[k]) && body[k] >= 0 && body[k] <= 600 : (k === "notify" || k === "notifyDone") && typeof body[k] === "boolean")
    if (!keys.length || !keys.every(ok)) return json(res, { error: "send notify, notifyDone as booleans, notifyDismiss as 0-600 seconds" }, 400)
    return json(res, settings.set(body))
  }
  if (get && parts[0] === "sources" && parts.length === 1) {
    await registry.list() // refresh per-source errors
    return json(res, registry.sources().map((s) => ({
      name: s.name, harness: s.harness, extras: Object.keys(s.extras ?? {}), actions: Object.keys(s.actions ?? {}), source: s.describe?.().source ?? null,
      ...(registry.error(s.name) ? { error: registry.error(s.name) } : {}),
    })))
  }
  if (get && parts[0] === "overview" && parts.length === 1) {
    const items = await place(await listed(), git, hidden())
    const shown = all ? items : items.filter((i) => !i.hidden)
    return json(res, { ...(await registry.overview(shown)), hidden: items.length - shown.length })
  }
  if (get && parts[0] === "items" && parts.length === 1) {
    const limit = q.get("limit")
    if (limit !== null && !/^\d{1,6}$/.test(limit)) return json(res, { error: "bad limit" }, 400)
    const source = q.get("source"), id = q.get("id")
    let items = await listed()
    if (source !== null) items = items.filter((i) => i.source === source)
    if (id !== null) items = items.filter((i) => i.id === id)
    return json(res, await placeFirst(items, git, hidden(), (i) => all || !i.hidden, limit === null ? Infinity : Number(limit)))
  }
  if (get && parts[0] === "projects" && parts.length === 1) {
    const tz = tzOf()
    if (!isTz(tz)) return json(res, { error: "bad tz" }, 400)
    const tree = await buildTree(await listed(), { git })
    return json(res, shapeTree(tree, { tz, now: now(), slim: q.get("slim") === "1", isHidden }))
  }
  if (get && parts[0] === "project" && parts.length === 2) {
    const key = decode(parts[1])
    const tz = tzOf()
    if (!isKey(key) || !isTz(tz)) return json(res, { error: "not allowed" }, 400)
    const p = (await buildTree(await listed(), { git, only: key })).find((x) => x.key === key)
    return p ? json(res, shapeTree([p], { tz, now: now(), isHidden })[0]) : json(res, { error: "no such project" }, 404)
  }
  if (get && parts[0] === "usage" && parts.length === 1) {
    const from = q.get("from") ?? undefined, to = q.get("to") ?? undefined, by = q.get("by") ?? "model"
    const tz = q.get("tz") ?? defaultTz()
    const day = { test: (v) => /^\d{4}-\d{2}-\d{2}$/.test(v) && Number.isFinite(Date.parse(`${v}T00:00:00Z`)) && new Date(`${v}T00:00:00Z`).toISOString().startsWith(v) }
    if ((from !== undefined && !day.test(from)) || (to !== undefined && !day.test(to)) || !isBy(by) || !isTz(tz)) return json(res, { error: "bad from, to, by or tz" }, 400)
    const rows = await registry.usage({ from, to, tz })
    const where = await projectsOf(rows.map((r) => r.project), { git })
    const named = rows.map((r) => {
      const p = where.get(r.project)
      return p ? { ...r, project: p.key, projectName: p.name } : { ...r, project: "no-project", projectName: "(no project)" }
    })
    return json(res, { ...aggregate(named, { by }), by, tz, from: from ?? null, to: to ?? null, complete: registry.usageComplete() })
  }
  if (parts[0] !== "item" || parts.length < 3) return false
  const source = decode(parts[1]), id = decode(parts[2])
  if (!isKey(source) || !isKey(id)) return json(res, { error: "not allowed" }, 400)
  const src = registry.source(source)
  if (!src) return json(res, { error: "no such source" }, 404)
  // A v1 adapter behind the source gets only run ids (no dots), as on the v1 routes; extras keep the
  // looser key (a repo basename such as "my.app").
  if (src.adapter && parts[3] !== "x" && !isRunId(id)) return json(res, { error: "not allowed" }, 400)
  if (get && parts.length === 3) {
    const item = await registry.get(source, id)
    return item ? json(res, item) : json(res, { error: "no such item" }, 404)
  }
  if (get && parts[3] === "calls" && parts.length === 4) {
    return json(res, await registry.calls(source, id, { lane: q.get("lane") ?? undefined, kind: q.get("kind") ?? undefined, q: q.get("q") ?? undefined }))
  }
  if (get && parts[3] === "turns" && parts.length === 4) {
    const lane = q.get("lane") ?? "main"
    const int = (k, d) => (q.has(k) ? (/^\d{1,7}$/.test(q.get(k)) ? Number(q.get(k)) : NaN) : d)
    const before = int("before", undefined), limit = int("limit", 100)
    if (!/^[\w-]{1,128}$/.test(lane) || Number.isNaN(before) || Number.isNaN(limit) || limit < 1 || limit > 500) return json(res, { error: "not allowed" }, 400)
    const t = await registry.turns(source, id, lane, { before, limit })
    return t ? json(res, t) : json(res, { error: "not found" }, 404)
  }
  if (get && parts[3] === "session" && parts.length === 5) {
    const name = decode(parts[4])
    if (!isSessionName(name)) return json(res, { error: "not allowed" }, 400)
    const s = await registry.session(source, id, name)
    return s ? json(res, s) : json(res, { error: "not found" }, 404)
  }
  if (get && parts[3] === "x" && parts.length === 5) {
    const key = decode(parts[4])
    const fn = Object.hasOwn(src.extras ?? {}, key) ? src.extras[key] : null
    if (!fn) return notFound(res)
    return sendExtra(res, await fn(id, url.searchParams))
  }
  if (req.method === "POST" && parts[3] === "title" && parts.length === 4) {
    const body = await readBody(req)
    if (!body || typeof body !== "object" || (body.title != null && typeof body.title !== "string")) return json(res, { error: "title must be a string" }, 400)
    if (!(await registry.get(source, id))) return json(res, { error: "no such item" }, 404)
    return json(res, { title: titles.set(source, id, body.title) })
  }
  if (req.method === "POST" && parts[3] === "mark" && parts.length === 4) {
    const body = await readBody(req)
    const ok = body && typeof body === "object" && ["pinned", "archived"].some((k) => typeof body[k] === "boolean") &&
      Object.keys(body).every((k) => (k === "pinned" || k === "archived") && typeof body[k] === "boolean")
    if (!ok) return json(res, { error: "send pinned and/or archived as booleans" }, 400)
    if (!(await registry.get(source, id))) return json(res, { error: "no such item" }, 404)
    return json(res, marks.set(source, id, body))
  }
  if (req.method === "POST" && parts[3] === "action" && parts.length === 5) {
    const name = decode(parts[4])
    const fn = Object.hasOwn(src.actions ?? {}, name) ? src.actions[name] : null
    if (!fn) return notFound(res)
    const raw = await readBody(req)
    const body = raw && typeof raw === "object" && !Array.isArray(raw) ? raw : {}
    return json(res, (await fn(id, body)) ?? {})
  }
  return false
}

async function api(ctx, req, res, url) {
  const { adapter } = ctx
  const parts = url.pathname.split("/").slice(2) // after "/api"
  const get = req.method === "GET" || req.method === "HEAD"
  try {
    if ((await apiV2(ctx, req, res, url, parts)) !== false) return
    // v1 routes below: aliases for the first adapter-backed source.
    if (!adapter) return notFound(res)
    if (get && parts[0] === "runs" && parts.length === 1) return json(res, await adapter.listRuns())
    if (get && parts[0] === "run" && parts.length === 2) {
      const id = decode(parts[1])
      const run = isRunId(id) ? await adapter.getRun(id) : null
      return run ? json(res, run) : json(res, { error: "no such run" }, 404)
    }
    if (get && parts[0] === "run" && parts[2] === "session" && parts.length === 4) {
      const id = decode(parts[1]), name = decode(parts[3])
      if (!isRunId(id) || !isSessionName(name)) return json(res, { error: "not allowed" }, 400)
      const s = await adapter.getSession(id, name)
      return s ? json(res, s) : json(res, { error: "not found" }, 404)
    }
    if (get && parts[0] === "crew" && parts.length === 1) {
      const repo = url.searchParams.get("repo")
      const base = (p) => String(p ?? "").split(/[\\/]/).filter(Boolean).pop()
      const runs = (await adapter.listRuns()).filter((r) => repo == null || base(r.repo) === repo)
      const full = (await Promise.all(runs.map((r) => adapter.getRun(r.id)))).map((d, i) => d && { id: runs[i].id, ...d })
      return json(res, crewStats(full.filter(Boolean)))
    }
    if (get && parts[0] === "x" && (parts.length === 2 || parts.length === 3)) {
      const key = decode(parts[1])
      const id = parts[2] === undefined ? null : decode(parts[2])
      const fn = Object.hasOwn(adapter.extras ?? {}, key) ? adapter.extras[key] : null
      if (!fn || (parts.length === 3 && !isExtrasId(id))) return notFound(res)
      return sendExtra(res, await fn(id, url.searchParams))
    }
    if (req.method === "POST" && parts[0] === "run" && parts[2] === "action" && parts.length === 4) {
      const id = decode(parts[1]), name = decode(parts[3])
      const fn = Object.hasOwn(adapter.actions ?? {}, name) ? adapter.actions[name] : null
      if (!fn || !isRunId(id)) return notFound(res)
      const raw = await readBody(req)
      const body = raw && typeof raw === "object" && !Array.isArray(raw) ? raw : {}
      return json(res, (await fn(id, body)) ?? {})
    }
  } catch (e) {
    if (Number.isInteger(e?.status)) return json(res, { error: e.message }, e.status)
    throw e
  }
  return notFound(res)
}

const LOOPBACK = ["localhost", "127.0.0.1", "[::1]"]

/**
 * `input` is one v1 adapter, one source, or an array of either. Every entry becomes a source;
 * the v1 routes (/api/runs, /api/run/..., /api/crew, /api/x/...) stay as aliases for the first adapter.
 */
export function createServer(input, { port = 4319, distDir = DEFAULT_DIST, git, config = null, titlesPath = null, marksPath = null, settingsPath = null, notifyLogPath = null, notifier = null, ackWaitMs = 5000, now = () => Date.now(), loops = null, heartbeatMs = 15_000, eventsPollMs = 1000, claudeHome = null, codexHome = null, prs = null, remote = null } = {}) {
  const entries = Array.isArray(input) ? input : [input]
  // Loop thresholds from config.json {"loops": {...}} (re-read when the file changes); `loops` injects them.
  const loopCfg = typeof loops === "function" ? loops : loops ? () => loops : createLoopConfig(config)
  const sources = entries.map((e) => (typeof e.listItems === "function" ? e : fromAdapter(e, { loops: loopCfg, now })))
  // `titlesPath`: where page renames live; null turns renaming off. The CLI passes ~/.mission-control/titles.json.
  const titles = createTitles(titlesPath)
  const marks = createMarks(marksPath)
  const registry = createRegistry(sources, { titles, marks })
  const adapter = entries.find((e) => typeof e.listRuns === "function") ?? null
  // What every list, count and the phone sees: archived items stay out unless asked for (`archived: true`) or
  // open again (resuming one never hides live work), and
  // the earlier part of a chat that changed session id (parkedInto) always does: it is listed once, under its newest id.
  const listed = async ({ archived = false } = {}) => (await registry.list()).filter((i) => !i.parkedInto && (archived || !i.archived || i.open === true))
  // `config`: path of config.json ({ "hide": [...] }); null reads nothing. The CLI passes ~/.mission-control/config.json.
  // `claudeHome` / `codexHome`: where the config readers look (names only); null reads nothing. The CLI passes the real ones.
  // `prs`: a createPrReader() for the per-PR usage view (null: none, so tests never run gh); budgets come from `config`.
  const settings = createSettings(settingsPath)
  // Each notification sent, and what the page reports back about showing it, also goes to `notifyLogPath`.
  const noteLog = (text) => {
    const line = `${new Date().toISOString()} ${text}`
    console.log(line)
    if (notifyLogPath) try {
      mkdirSync(dirname(notifyLogPath), { recursive: true, mode: 0o700 })
      // Kept to about 1 MB: the previous log moves to .1, replacing the one before it.
      try { if (statSync(notifyLogPath).size > 1_000_000) renameSync(notifyLogPath, `${notifyLogPath}.1`) } catch { /* no log yet */ }
      appendFileSync(notifyLogPath, line + "\n", { mode: 0o600 })
    } catch { /* logging must not break notifying */ }
  }
  let notifyVia = async (m) => (noteLog(`notify ${m.title}: ${m.subtitle ?? ""} via none (server starting)`), "none") // set once listening
  const shownOnPage = new Map() // group -> { m, at }: sent to a tab, until it reports back
  let pageFailed = () => {} // set once listening
  const pageShown = (group) => shownOnPage.delete(group)
  const ctx = { adapter, registry, git, hide: createHide(config), now, claudeHome, codexHome, configPath: config, prs, budgets: createBudgets(config), windowConfig: createWindowConfig(config), titles, marks, listed, settings, noteLog, testNotify: (m) => notifyVia(m), pageFailed: (g) => pageFailed(g), pageShown }
  // v2.3 remote answering: `remote` = { home, remoteDir, hooksDir, flags?, ... } turns on the runtime
  // control (status, POST /api/remote/enabled, the second listener). Without it, status is read-only defaults.
  let actualPort = port
  // What the phone, the notifier and every surface agree on: listed() without hidden (noise) projects.
  const shown = async () => (await place(await listed(), git, ctx.hide.list())).filter((i) => !i.hidden)
  const needsYou = async () => (await registry.overview(await shown())).needsYou
  // With the notifier on, its dispatcher decides which channel gets each prompt, so the remote server does
  // not ping phones on its own as well.
  const remoteControl = remote
    ? createRemoteControl({ configPath: config, distDir, needsYou, watchDirs: () => registry.watchTargets().dirs, dashboardPort: () => actualPort, ...(notifier ? { pushOnNewPrompt: false } : {}), ...remote })
    : null
  if (!existsSync(join(distDir, "index.html"))) {
    console.error(`mission control: no built page at ${join(distDir, "index.html")} — run npm run build`)
  }
  // Server-Sent Events: "changed" when a hook line lands or a live session file grows; "heartbeat" keeps
  // the page's freshness badge honest; "notify" carries a notification to a page that asked for them
  // (?notify=1, with &visible=1 while its tab is in view). The feed runs only while at least one page listens.
  const clients = new Set()
  const notifyPages = new Map() // res -> whether its tab is visible
  const drop = (r) => {
    clients.delete(r)
    notifyPages.delete(r)
    if (!clients.size) feed.stop()
  }
  // One dead socket must not stop the others (or the feed callback): a failed write drops that client only.
  const send = (event, data = {}, to = clients) => {
    const frame = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`
    for (const r of to) {
      try { r.write(frame) } catch { drop(r); try { r.destroy() } catch { /* already gone */ } }
    }
  }
  const feed = createChangeFeed({ targets: () => registry.watchTargets(), pollMs: eventsPollMs, onChange: () => send("changed") })
  const beat = setInterval(() => send("heartbeat"), heartbeatMs)
  beat.unref?.()
  function openEvents(req, res) {
    res.writeHead(200, { "content-type": "text/event-stream; charset=utf-8", "cache-control": "no-store", connection: "keep-alive", "x-accel-buffering": "no" })
    res.write("retry: 2000\nevent: heartbeat\ndata: {}\n\n")
    clients.add(res)
    const q = new URL(req.url, "http://localhost").searchParams
    if (q.get("notify") === "1") notifyPages.set(res, q.get("visible") === "1")
    feed.start()
    res.on("error", () => drop(res))
    req.on("close", () => drop(res))
  }

  // Filled once the actual port is known (port 0 picks one).
  let hosts = new Set(), origins = new Set()
  const handler = async (req, res) => {
    // DNS rebinding: a foreign page can reach 127.0.0.1 under its own hostname. Only loopback
    // Host names on our own port are served, so the Origin check below cannot be fooled.
    if (!hosts.has(req.headers.host)) return json(res, { error: "host not allowed" }, 403)
    try {
      const url = new URL(req.url, "http://localhost")
      if (url.pathname === "/api/remote" || url.pathname.startsWith("/api/remote/")) return await remoteRoutes(req, res, url)
      if (req.method === "POST") {
        // A cross-site form can only send simple content types; requiring JSON stops it.
        const type = String(req.headers["content-type"] ?? "").split(";")[0].trim().toLowerCase()
        if (type !== "application/json") return json(res, { error: "content-type must be application/json" }, 415)
        const origin = req.headers.origin
        if (origin !== undefined && !origins.has(origin)) return json(res, { error: "cross-origin request refused" }, 403)
        return await api(ctx, req, res, url)
      }
      if (req.method !== "GET" && req.method !== "HEAD") return json(res, { error: "not found" }, 404)
      if (url.pathname === "/api/capabilities") {
        return json(res, {
          adapter: adapter?.name ?? null,
          extras: Object.keys(adapter?.extras ?? {}),
          actions: Object.keys(adapter?.actions ?? {}),
          source: adapter?.describe?.().source ?? null,
        })
      }
      if (url.pathname === "/api/events") {
        // An EventSource from another site would send its Origin: refuse it like a cross-site POST.
        const origin = req.headers.origin
        if (origin !== undefined && !origins.has(origin)) return json(res, { error: "cross-origin request refused" }, 403)
        if (req.method === "HEAD") return json(res, {})
        return openEvents(req, res)
      }
      if (url.pathname.startsWith("/api/")) return await api(ctx, req, res, url)
      return await serveStatic(res, distDir, url.pathname)
    } catch (e) {
      json(res, { error: String(e?.message ?? e) }, 500)
    }
  }

  /**
   * The only remote routes on this listener (C9): GET /api/remote/status (read-only) and POST
   * /api/remote/enabled, the one write route (C38). Every other /api/remote/* path or method is 404.
   */
  async function remoteRoutes(req, res, url) {
    if (url.pathname === "/api/remote/status" && (req.method === "GET" || req.method === "HEAD")) {
      const o = req.headers.origin
      if (o !== undefined && !origins.has(o)) return json(res, { error: "cross-origin request refused" }, 403)
      return json(res, remoteControl ? remoteControl.status() : staticStatus({ configPath: config, now: now() }))
    }
    if (url.pathname !== "/api/remote/enabled" || req.method !== "POST" || !remoteControl) return json(res, { error: "not found" }, 404)
    // Guards in contract order: Host (checked above), then a required same-origin Origin, then JSON.
    const origin = req.headers.origin
    if (origin === undefined || origin !== `http://${req.headers.host}`) return json(res, { error: "same-origin Origin header required" }, 403)
    const type = String(req.headers["content-type"] ?? "").split(";")[0].trim().toLowerCase()
    if (type !== "application/json") return json(res, { error: "content-type must be application/json" }, 415)
    let body
    try { body = await readBody(req) } catch (e) { return json(res, { error: e?.message ?? "bad body" }, Number.isInteger(e?.status) ? e.status : 400) }
    if (!body || typeof body !== "object" || Array.isArray(body) || Object.keys(body).length !== 1 || typeof body.enabled !== "boolean") {
      return json(res, { error: "body must be exactly {\"enabled\": true|false}" }, 400)
    }
    const r = await remoteControl.setEnabled(body.enabled, "dashboard")
    return json(res, r.body, r.status)
  }

  // Loopback only, on both IPv4 and IPv6: browsers often resolve "localhost" to ::1 first.
  return new Promise((resolveStart, reject) => {
    const v4 = createHttpServer(handler)
    v4.once("error", (e) => {
      console.error(
        `mission control: cannot listen on ${port}: ${e.code === "EADDRINUSE" ? "the port is in use (another dashboard?); pass --port" : e.message}`,
      )
      reject(e)
    })
    v4.listen(port, "127.0.0.1", () => {
      const actual = v4.address().port
      actualPort = actual
      hosts = new Set(LOOPBACK.map((h) => `${h}:${actual}`))
      origins = new Set(LOOPBACK.map((h) => `http://${h}:${actual}`))
      const v6 = createHttpServer(handler)
      // Not fatal: 127.0.0.1 is up; browsers that try ::1 first fall back to it.
      v6.on("error", (e) => console.error(`mission control: ::1 listener failed: ${e.code ?? e.message}`))
      v6.listen(actual, "::1")
      console.log(`mission control on http://localhost:${actual}`)
      // `notifier`: { mac } turns notifications on (mac: the macOS fallback, or null); the sidebar switches and
      // paired phones decide what is sent, the dispatcher where. Off (null) in tests unless injected.
      const watcher = notifier ? (() => {
        const link = (n) => `#/item/${encodeURIComponent(n.source)}/${encodeURIComponent(n.id)}/lanes`
        // A tab takes a notification only while the sidebar switch for its kind is on (see createDispatcher).
        const wants = (m) => (m.kind === "done" ? settings.get().notifyDone : m.kind === "needs" ? settings.get().notify : true)
        const pages = () => { let visible = 0, hidden = 0; for (const v of notifyPages.values()) v ? visible++ : hidden++; return { visible, hidden } }
        // The most recently connected tab of that kind: one alert (and one ack) however many tabs are open.
        const toPages = (visible, m) => {
          const r = [...notifyPages].filter(([, v]) => v === visible).map(([res]) => res).pop()
          if (!r) return
          const at = Date.now()
          if (m.group) shownOnPage.set(m.group, { m, at })
          send("notify", { ...m, dismissAfter: settings.get().notifyDismiss }, [r])
          // A tab that never answers (a half-closed connection still counts as connected) failed too.
          if (m.group) setTimeout(() => { if (shownOnPage.get(m.group)?.at === at) pageFailed(m.group, "no answer from the page") }, ackWaitMs).unref?.()
        }
        const mac = notifier.mac === true ? macNotify : notifier.mac || null
        const dispatch = createDispatcher({ pages, toPages, phone: remoteControl?.push ?? null, mac, wants })
        // A tab that reports it could not show one (permission gone, an error) hands it to macOS once.
        pageFailed = (group, why = "the page could not show it") => {
          const p = shownOnPage.get(group)
          shownOnPage.delete(group)
          if (!p || Date.now() - p.at > 60_000 || !mac) return
          mac(p.m)
          noteLog(`notify ${p.m.title}: ${p.m.subtitle ?? ""} via macOS (${why})`)
        }
        notifyVia = async (m) => {
          const via = await dispatch(m)
          noteLog(`notify ${m.title}: ${m.subtitle ?? ""} via ${via}`)
          return via
        }
        const phoneOn = () => !!remoteControl?.push.available()
        const enabled = (kind) => (kind === "done" ? settings.get().notifyDone : settings.get().notify || phoneOn())
        return startNotifier({ list: shown, overview: (items) => registry.overview(items), enabled, link, notify: notifyVia })
      })() : null
      // Warm caches (Claude Code list, usage scan) without holding the first request.
      for (const s of registry.sources()) Promise.resolve().then(() => s.warm?.()).catch(() => {})
      resolveStart({
        port: actual,
        remote: remoteControl,
        needsYou, // what the phone is offered (no hidden, archived or parked items); exposed for tests
        close: async () => {
          await remoteControl?.close().catch(() => {})
          return new Promise((done) => {
            clearInterval(beat)
            watcher?.stop()
            feed.stop()
            for (const r of clients) r.end()
            clients.clear()
            v6.close(() => v4.close(() => done()))
            v4.closeAllConnections?.()
            v6.closeAllConnections?.()
          })
        },
      })
    })
  })
}
