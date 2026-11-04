import { spawnSync } from "node:child_process"
import { closeSync, openSync, readSync, readdirSync, readFileSync, realpathSync, statSync } from "node:fs"
import { homedir } from "node:os"
import { dirname, join, sep } from "node:path"
import { UNCONFIRMED_MS, askOf, createWaitingReader, readyOf } from "../../hooks.mjs"
import { capText, isSessionName } from "../../names.mjs"
import { createCache } from "./cache.mjs"
import { parseTranscript, peek, transcriptAcc, turnsAcc } from "./parse.mjs"
import { createTail, parseFileWith } from "./tail.mjs"
import { costOf } from "./prices.mjs"
import { LOOP_DEFAULTS, applyLoops, tokenMessages } from "../../loops.mjs"
import { createUsageScanner } from "./usage.mjs"
import { turnCosts } from "../../turn-costs.mjs"

const LIVE_MS = 2 * 60 * 1000
const TAIL_BYTES = 64 * 1024
const WAIT_EXPIRY_MS = 12 * 3600 * 1000
const CLEAR_GAP_MS = 2000
const HEAD_BYTES = 64 * 1024
const TITLE_TAIL = 256 * 1024 // Claude Code re-appends its /rename and generated-title lines every few turns, so the newest sit near the end
const HEAD_MAX = 1024 * 1024 // read forward this far for the first line carrying a cwd
const SESSIONS = 256 // parsed sessions kept, whatever their lane count
const SESSION_TEXT = 200_000 // getSession returns at most this many bytes
const SAFE = /^[\w-][\w.-]*$/ // one path segment: no separators, never starts with a dot
const zero = () => ({ in: 0, out: 0, cacheRead: 0, cacheWrite: 0 })
const add = (a, b) => { a.in += b.in; a.out += b.out; a.cacheRead += b.cacheRead; a.cacheWrite += b.cacheWrite }
const iso = (ms) => new Date(ms).toISOString()
const shq = (s) => (/^[\w@%+=:,./-]+$/.test(s) ? s : `'${s.replace(/'/g, `'\\''`)}'`)

/**
 * Whether a sessions file's procStart can be compared with `ps -o lstart=`: the lstart text Claude Code writes on
 * macOS ("Tue Nov  3 16:45:05 2026"). Another format (or another pidDomain) is not compared, so a live pid stays open.
 */
export const comparableStart = (j) =>
  typeof j?.procStart === "string" && /^\w{3} \w{3} +\d{1,2} \d\d:\d\d:\d\d \d{4}$/.test(j.procStart.trim()) && (j.pidDomain ?? "darwin") === "darwin"

const startCache = new Map() // pid -> { at, value }: `ps` once a minute per pid at most
/**
 * When a process started, as `ps -o lstart=` prints it in UTC (Claude Code's procStart is UTC), whitespace
 * folded; null when `ps` cannot say (no such pid, no `ps`), so the caller keeps the plain pid check.
 */
export function processStart(pid, { spawn = spawnSync } = {}) {
  const hit = startCache.get(pid)
  if (hit && Date.now() - hit.at < 60_000) return hit.value
  let value = null
  try {
    const r = spawn("ps", ["-o", "lstart=", "-p", String(pid)], { encoding: "utf8", timeout: 2000, env: { ...process.env, TZ: "UTC" } })
    value = r.status === 0 ? r.stdout.replace(/\s+/g, " ").trim() || null : null
  } catch { value = null }
  if (startCache.size > 512) startCache.clear() // pids come and go over a long uptime; a refill costs one `ps` each
  startCache.set(pid, { at: Date.now(), value })
  return value
}

/**
 * Claude Code sessions as a v2 source. `root` is the projects dir (default ~/.claude/projects),
 * `now` an injectable clock. `hooksDir` holds the level-1 hook logs: a session whose last Notification is
 * unanswered is "waiting" (an idle reminder is "ready", i.e. idle). Read-only; every file read is confined to the real path of `root`. `cachePath` is where the
 * usage scan persists its per-file results (omitted: memory only); `parse` (text -> parseTranscript result,
 * usage scan only) and `onParse(path, { bytes, full })` (every transcript read for items, calls and turns)
 * are for tests, and so is `startOf` (pid -> its start time, null when unknown).
 */
export function create({ root, now = () => Date.now(), hooksDir, cachePath, parse = parseTranscript, startOf = processStart, onParse, loops = () => LOOP_DEFAULTS } = {}) {
  const cache = createCache() // key helper for the head cache below
  // id -> { stamp, tails, data }: one parse per session version (stamp = identity of all its files), shared by
  // getItem, getCalls and the overview. tails keeps each file's incremental reader, so a growing
  // transcript is parsed only for its new lines.
  const sessions = createCache(SESSIONS)
  const turned = createCache(8) // real path -> incremental parseTurns of that file, for chat paging
  const readWaiting = createWaitingReader() // hook logs, cached by size+mtime, tail-read when large
  const lastTurns = createCache(4096) // path|size|mtime -> newest turn time in the tail of a main log
  const peeked = createCache(8192) // path|size|mtime -> peek of the head, so warm lists skip file reads
  const tailTitles = createCache(8192) // path|size|mtime -> title from the tail: /rename, else generated (or null)
  const opened = new Map() // id -> { lastMs, summary } of sessions already fully parsed, for list totals
  let liveFiles = [] // main logs of sessions live or waiting at the last listing, for /api/events
  let realRoot = null
  const rootReal = () => (realRoot ??= realpathSync(root))

  /** stat + confinement: the file's real path must sit inside the root, else null. */
  function confined(file) {
    try {
      const real = realpathSync(file)
      if (!real.startsWith(rootReal() + sep)) return null
      const st = statSync(real)
      return st.isFile() ? { real, st } : null
    } catch { return null }
  }

  /** The first `bytes` of a file as text (or as a Buffer with `raw`). */
  function head(file, bytes, raw = false) {
    let fd
    try {
      fd = openSync(file, "r")
      const buf = Buffer.alloc(bytes)
      const n = readSync(fd, buf, 0, bytes, 0)
      return raw ? buf.subarray(0, n) : buf.toString("utf8", 0, n)
    } finally { if (fd !== undefined) closeSync(fd) }
  }

  /**
   * Claude Code slugs replace "/" with "-", so a decoded path is only a hint (real dashes are lost):
   * walk the slug segment by segment, joining with "-" where the plain split names no directory.
   * Returns a real directory or null.
   */
  function slugCwd(slug) {
    const parts = slug.split("-").slice(1)
    const walk = (base, i) => {
      if (i === parts.length) return base
      for (let j = parts.length; j > i; j--) {
        const next = join(base, parts.slice(i, j).join("-"))
        let ok = false
        try { ok = statSync(next).isDirectory() } catch { /* not there */ }
        if (ok) { const r = walk(next, j); if (r) return r }
      }
      return null
    }
    return slug.startsWith("-") && parts.length ? walk(sep, 0) : null
  }

  /** peek of the file head: 64 KB first, then up to 1 MB when no line with a cwd was seen, then the slug. */
  function peekFile(c, slug) {
    let h = peek(head(c.real, HEAD_BYTES))
    if (!h.cwd && c.st.size > HEAD_BYTES) h = peek(head(c.real, Math.min(c.st.size, HEAD_MAX)))
    if (!h.cwd) h.cwd = slugCwd(slug)
    return h
  }

  const dirs = (p) => { try { return readdirSync(p, { withFileTypes: true }) } catch { return [] } }

  /** Session files on disk: { id, file, slug } for every <root>/<slug>/<id>.jsonl. */
  function sessionFiles() {
    const out = []
    for (const d of dirs(root)) {
      if (!d.isDirectory() || !SAFE.test(d.name)) continue
      for (const f of dirs(join(root, d.name))) {
        if (f.isFile() && f.name.endsWith(".jsonl") && SAFE.test(f.name)) out.push({ id: f.name.slice(0, -6), slug: d.name, file: join(root, d.name, f.name) })
      }
    }
    return out
  }

  function locate(id) {
    if (typeof id !== "string" || !SAFE.test(id)) return null
    for (const d of dirs(root)) {
      if (!d.isDirectory() || !SAFE.test(d.name)) continue
      const file = join(root, d.name, `${id}.jsonl`)
      if (confined(file)) return { id, slug: d.name, file }
    }
    return null
  }

  /** Subagent transcripts of a session: [{ aid, file, metaFile }], from the directory listing only. */
  function subagents(s) {
    const dir = join(root, s.slug, s.id, "subagents")
    const out = []
    for (const f of dirs(dir)) {
      const m = /^agent-([\w-]+)\.jsonl$/.exec(f.name)
      if (m && f.isFile()) out.push({ aid: m[1], file: join(dir, f.name), metaFile: join(dir, `agent-${m[1]}.meta.json`) })
    }
    return out.sort((a, b) => a.aid.localeCompare(b.aid))
  }

  /** A subagent's meta.json ({} when missing or broken: the lane keeps its id as label). */
  function readMeta(c) {
    try {
      const j = c && JSON.parse(readFileSync(c.real, "utf8"))
      return j && typeof j === "object" && !Array.isArray(j) ? j : {}
    } catch { return {} }
  }

  /** Every transcript that counts toward usage: sessions and their subagents, with stat. */
  function usageFiles() {
    const out = []
    for (const s of sessionFiles()) {
      const c = confined(s.file)
      if (!c) continue
      out.push({ session: s.id, main: true, file: c.real, st: c.st })
      for (const a of subagents(s)) {
        const ac = confined(a.file)
        if (ac) out.push({ session: s.id, main: false, file: ac.real, st: ac.st })
      }
    }
    return out
  }
  // The default parser streams the file in chunks (no string size limit); an injected one gets the text.
  const parseFile = parse === parseTranscript ? (file, st) => parseFileWith(() => transcriptAcc(), file, st) : (file) => parse(readFileSync(file, "utf8"))
  const scanner = createUsageScanner({ files: usageFiles, parseFile, costOf, cachePath, now })

  /** Newest user/assistant record timestamp (ms) in the tail of a main log; summary/system lines are ignored. */
  function lastTurnMs(file, size) {
    let fd
    try {
      fd = openSync(file, "r")
      const n = Math.min(size, TAIL_BYTES)
      const buf = Buffer.alloc(n)
      readSync(fd, buf, 0, n, size - n)
      let best = 0
      for (const line of buf.toString("utf8").split("\n")) {
        if (!line.includes('"timestamp"')) continue
        try {
          const j = JSON.parse(line)
          if (j && (j.type === "user" || j.type === "assistant")) best = Math.max(best, Date.parse(j.timestamp) || 0)
        } catch { /* half-written or cut first line */ }
      }
      return best
    } catch { return 0 } finally { if (fd !== undefined) closeSync(fd) }
  }

  /**
   * The title from the tail of a main log: the newest /rename (custom-title line), else the newest title
   * Claude Code generated (ai-title line); null when neither is there. Both are re-appended every few turns.
   */
  function tailTitle(file, size) {
    let fd
    try {
      fd = openSync(file, "r")
      const n = Math.min(size, TITLE_TAIL)
      const buf = Buffer.alloc(n)
      readSync(fd, buf, 0, n, size - n)
      const lines = buf.toString("utf8").split("\n")
      let ai = null
      for (let i = lines.length - 1; i >= 0; i--) {
        const l = lines[i]
        if (!l.includes('"custom-title"') && (ai || !l.includes('"ai-title"'))) continue
        try {
          const j = JSON.parse(l)
          if (j?.type === "custom-title" && typeof j.customTitle === "string" && j.customTitle.trim()) return j.customTitle.trim()
          if (j?.type === "ai-title" && typeof j.aiTitle === "string" && j.aiTitle.trim()) ai = j.aiTitle.trim()
        } catch { /* half-written or cut first line */ }
      }
      return ai
    } catch { return null } finally { if (fd !== undefined) closeSync(fd) }
  }

  // Lists, item pages and the change feed all ask within the same poll: read the pid files at most once a second.
  let openMemo = { at: -Infinity, value: null }
  function openSessions() {
    if (Date.now() - openMemo.at < 1000) return openMemo.value
    openMemo = { at: Date.now(), value: readOpenSessions() }
    return openMemo.value
  }
  /**
   * Running Claude Code processes by session id, from the <config dir>/sessions/<pid>.json files Claude Code
   * keeps next to projects/ (status "busy" or "idle"). A file whose pid is gone is a closed session. null when
   * there is no such dir (an older Claude Code, or a projects dir passed on its own): open state is unknown.
   */
  function readOpenSessions() {
    const dir = join(dirname(root), "sessions")
    let names
    try { names = readdirSync(dir) } catch { return null }
    const out = new Map()
    const parked = [] // [sessionId, jobId]: the chat behind this session id continues under the job's session id
    const jobs = new Map() // background jobId -> its sessionId
    for (const n of names) {
      if (!/^\d+\.json$/.test(n)) continue
      try {
        const j = JSON.parse(readFileSync(join(dir, n), "utf8"))
        if (typeof j?.sessionId !== "string" || !Number.isInteger(j.pid) || j.pid <= 0) continue
        try { process.kill(j.pid, 0) } catch (e) { if (e.code !== "EPERM") continue } // signal 0 only checks the pid exists
        // A pid can be reused after a crash: a live pid that started at another time than the file says is not it.
        const started = comparableStart(j) ? startOf(j.pid) : null
        if (started && started !== j.procStart.replace(/\s+/g, " ").trim()) continue
        const since = Number.isFinite(j.statusUpdatedAt) ? new Date(j.statusUpdatedAt).toISOString() : null
        out.set(j.sessionId, { busy: j.status === "busy", since })
        if (typeof j.jobId === "string") jobs.set(j.jobId, j.sessionId)
        if (typeof j.parkedJobId === "string") parked.push([j.sessionId, j.parkedJobId])
      } catch { /* half-written or unreadable: skip */ }
    }
    // Only a job whose session is still open counts: once the job's process exits, its jobId names no session,
    // and pointing at it would hide this chat with nothing listed in its place.
    for (const [id, job] of parked) {
      const into = jobs.get(job)
      if (!into || !out.has(into) || into === id) continue
      out.get(id).parkedInto = into
      out.get(into).continuedFrom = id
    }
    return out
  }

  /** The shell command that resumes a session in its own folder, under the config dir it was recorded in. */
  function resumeOf(x) {
    const cfg = dirname(root)
    const env = cfg === join(homedir(), ".claude") ? "" : `CLAUDE_CONFIG_DIR=${shq(cfg)} `
    return `${x.cwd ? `cd ${shq(x.cwd)} && ` : ""}${env}claude --resume ${x.id}`
  }

  /**
   * `x` with `open` and status from the running process, which beats file times: an idle Claude Code still
   * appends metadata every few minutes. Busy is working (or looping), open and not busy is idle and ready
   * (unless the hooks say it waits on you), and a closed session is idle, never waiting and never ready.
   */
  function withProcess(x, procs) {
    x = { ...x, resume: resumeOf(x) }
    if (!procs) return x
    const p = procs.get(x.id)
    const { ready, readySince, ...rest } = x
    if (!p) return { ...rest, open: false, live: false, status: "idle", waiting: false } // closed: never ready
    const base = p.continuedFrom ? { ...rest, continuedFrom: p.continuedFrom } : rest // the earlier session id of the same chat
    // Parked (parkedJobId): the chat went on under the job's session id, and this id's last status ("busy") stays
    // frozen. The terminal is still attached; only the session id changed. Ready or not shows under the new id.
    if (p.parkedInto) return { ...base, open: true, live: false, status: "idle", waiting: false, parkedInto: p.parkedInto }
    if (x.status === "waiting") return { ...base, open: true }
    if (p.busy) return { ...base, open: true, live: true, status: x.status === "looping" ? "looping" : "working" }
    // Open and not busy: ready for your next prompt now, without waiting for the hooks' idle reminder.
    return { ...base, open: true, live: false, status: "idle", ready: true, ...(p.since ?? readySince ? { readySince: p.since ?? readySince } : {}) }
  }

  /**
   * Hook-derived state: { waiting, message } or { ready } or null. A Notification stays open until a clearing
   * hook arrives or the MAIN log gains a user/assistant record more than 2 s after it; it expires after 12 h.
   */
  function waitingOf(id, main, logged) {
    if (!hooksDir || (logged && !logged.has(`${id}.jsonl`))) return null
    const w = readWaiting(hooksDir, id)
    if (!w.waiting && !w.ready) return null
    const since = Date.parse(w.since)
    if (Number.isFinite(since)) {
      if (now() - since > WAIT_EXPIRY_MS) return null
      // A subagent's PermissionRequest no Notification confirmed: it was auto-denied in a session that cannot prompt.
      if (w.tentative && now() - since > UNCONFIRMED_MS) return null
      const k = cache.key(main.real, main.st)
      const last = lastTurns.get(k) ?? lastTurns.set(k, lastTurnMs(main.real, main.st.size))
      if (last > since + CLEAR_GAP_MS) return null
    }
    return w
  }

  const liveAt = (ms) => now() - ms <= LIVE_MS

  function laneOf(p, { id, label, kind, parent, model, live, finished }) {
    const lane = {
      id, label, kind,
      status: finished ? "done" : live ? "working" : "idle",
      calls: p.calls.length, errors: p.errors, tokens: p.tokens, cost: p.cost,
    }
    const m = model ?? p.firstModel
    if (m) lane.model = m
    if (parent) lane.parent = parent
    if (p.nowDoing && !finished) lane.nowDoing = p.nowDoing
    if (p.firstTs) lane.startedAt = p.firstTs
    if (p.lastTs && (finished || !live)) lane.endedAt = p.lastTs
    return lane
  }

  /**
   * The parsed files of one session, rebuilt only when one of its files (transcripts or meta) changed:
   * { main, mp, subs: [{ aid, p, meta, mt }], calls (all lanes, sorted, Agent calls linked), lastMs }.
   * A changed file is read incrementally (only appended bytes); unchanged ones are not read at all.
   */
  function parsed(s) {
    const main = confined(s.file)
    if (!main) return null
    const found = subagents(s).map((a) => ({ ...a, c: confined(a.file), m: confined(a.metaFile) })).filter((a) => a.c)
    const id = (c) => (c ? `${c.real}|${c.st.ino}|${c.st.size}|${c.st.mtimeMs}` : "-")
    const stamp = [id(main), ...found.map((a) => `${id(a.c)}>${id(a.m)}`)].join("\n")
    const prev = sessions.get(s.id)
    if (prev && prev.stamp === stamp) return prev.data
    const tails = new Map()
    const read = (c, lane) => {
      const t = prev?.tails.get(c.real) ?? createTail(() => transcriptAcc(lane), onParse)
      try { t.update(c.real, c.st) } catch { return null } // vanished or unreadable mid-read
      tails.set(c.real, t)
      return t.result()
    }
    const mp = read(main, "main")
    if (!mp) return null
    const subs = []
    const okStamp = [id(main)] // only files that were read: a failed one makes the next call's stamp differ, so it is retried
    for (const a of found) {
      const p = read(a.c, `agent-${a.aid}`)
      if (p) { subs.push({ aid: a.aid, p, meta: readMeta(a.m), mt: a.c.st.mtimeMs }); okStamp.push(`${id(a.c)}>${id(a.m)}`) }
    }
    const calls = mp.calls.map((c) => ({ ...c }))
    const byUse = new Map(calls.map((c) => [c.id, c]))
    for (const a of subs) {
      const lane = `agent-${a.aid}`
      for (const c of a.p.calls) calls.push({ ...c, lane })
      const link = typeof a.meta.toolUseId === "string" ? byUse.get(a.meta.toolUseId) : null
      if (link && link.kind === "agent") link.subLane = lane
    }
    calls.sort((x, y) => x.ts.localeCompare(y.ts))
    const lastMs = Math.max(main.st.mtimeMs, ...subs.map((a) => a.mt))
    const data = { main, mp, subs, calls, lastMs }
    sessions.set(s.id, { stamp: okStamp.length === found.length + 1 ? stamp : okStamp.join("\n"), tails, data })
    return data
  }

  /** One session: summary and lanes from the parsed files, with liveness (clock) and hook state applied now. */
  function load(s) {
    const d = parsed(s)
    if (!d) return null
    const { main, mp, subs, calls, lastMs } = d
    const live = liveAt(lastMs)
    const lanes = [laneOf(mp, { id: "main", label: "main", kind: "main", live })]
    for (const a of subs) {
      const id = `agent-${a.aid}`
      const label = typeof a.meta.description === "string" && a.meta.description ? a.meta.description : a.aid
      lanes.push({
        ...laneOf(a.p, { id, label, kind: "subagent", parent: "main", model: typeof a.meta.model === "string" ? a.meta.model : undefined, live: liveAt(a.mt), finished: a.meta.finished === true }),
        ...(typeof a.meta.agentType === "string" ? { agentType: a.meta.agentType } : {}),
      })
    }
    const tokens = zero()
    let cost = 0, errors = 0
    for (const l of lanes) { add(tokens, l.tokens); cost += l.cost; errors += l.errors }
    const running = lanes.some((l) => l.status === "working")
    const w = waitingOf(s.id, main)
    // Loops and tokens-since-last-change per lane (a session waiting on you or ready is not looping).
    const parts = [{ lane: lanes[0], calls: mp.calls, messages: tokenMessages(mp.messages, costOf) }, ...subs.map((a, i) => ({ lane: lanes[i + 1], calls: a.p.calls, messages: tokenMessages(a.p.messages, costOf) }))]
    const lp = applyLoops(parts, { now: now(), config: loops(), detect: !w?.waiting && !w?.ready })
    if (w?.waiting) {
      lanes[0].status = "waiting"
      lanes[0].reason = w.message ?? "Waiting for you"
      lanes[0].ask = askOf(w)
    } else if (w?.ready) {
      lanes[0].status = "idle"
      lanes[0].reason = "ready for input"
    }
    const summary = {
      source: "claude-code", id: s.id, kind: "session",
      title: mp.meta.title ?? s.id, harness: "claude-code",
      cwd: mp.meta.cwd, branch: mp.meta.branch,
      // A session the hooks call ready (idle reminder) is not live, whatever its file times say.
      live: running && !w?.ready, status: w?.waiting ? "waiting" : w?.ready ? "idle" : running ? (lp.loop ? "looping" : "working") : "idle", waiting: !!w?.waiting,
      startedAt: mp.firstTs, updatedAt: iso(lastMs),
      counts: { lanes: lanes.length, calls: calls.length, errors },
      tokens, cost,
      sinceChange: lp.sinceChange,
      ...(lp.loop ? { loop: lp.loop } : {}),
      ...readyOf(w),
    }
    if (mp.meta.version) summary.version = mp.meta.version
    if (mp.meta.recap) summary.recap = mp.meta.recap
    opened.set(s.id, { lastMs, summary })
    return { summary, lanes, calls, events: [] }
  }

  return {
    name: "claude-code",
    harness: "claude-code",

    /** stat + the first 64 KB of each file only; totals appear once a session has been opened. */
    async listItems() {
      const items = []
      const watched = []
      const logged = new Set(hooksDir ? dirs(hooksDir).map((d) => d.name) : []) // one readdir instead of a miss per session
      const procs = openSessions()
      for (const s of sessionFiles()) {
        try {
          const c = confined(s.file)
          if (!c) continue
          const subs = dirs(join(root, s.slug, s.id, "subagents")).filter((f) => f.isFile() && /^agent-[\w-]+\.jsonl$/.test(f.name))
          let lastMs = c.st.mtimeMs
          for (const f of subs) lastMs = Math.max(lastMs, confined(join(root, s.slug, s.id, "subagents", f.name))?.st.mtimeMs ?? 0)
          const pk = cache.key(c.real, c.st)
          const h = peeked.get(pk) ?? peeked.set(pk, peekFile(c, s.slug))
          let rt = tailTitles.get(pk)
          if (rt === undefined) rt = tailTitles.set(pk, tailTitle(c.real, c.st.size))
          const o = opened.get(s.id)
          const done = o && o.lastMs === lastMs ? o.summary : null
          const live = liveAt(lastMs)
          const w = waitingOf(s.id, c, logged)
          if (live || w?.waiting) watched.push(c.real)
          items.push(withProcess({
            source: "claude-code", id: s.id, kind: "session",
            title: rt ?? h.title ?? s.id, harness: "claude-code",
            cwd: h.cwd, branch: h.branch,
            // Looping is known once the session was opened (the overview opens every busy one each poll).
            live: live && !w?.ready, status: w?.waiting ? "waiting" : w?.ready ? "idle" : live ? (o?.summary.status === "looping" ? "looping" : "working") : "idle", waiting: !!w?.waiting,
            startedAt: h.startedAt, updatedAt: iso(lastMs),
            ...(o?.summary.sinceChange ? { sinceChange: o.summary.sinceChange } : {}),
            ...(live && o?.summary.loop && !w?.waiting && !w?.ready ? { loop: o.summary.loop } : {}),
            counts: { lanes: 1 + subs.length, calls: done?.counts.calls ?? 0, errors: done?.counts.errors ?? 0 },
            tokens: done?.tokens ?? zero(), cost: done?.cost ?? 0,
            ...readyOf(w),
            ...(done ? {} : { partial: true }), // totals appear once the session is opened
          }, procs))
        } catch { /* one unreadable file must not hide the rest */ }
      }
      liveFiles = watched
      return items.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
    },

    /** For /api/events: the hook log dir and the main logs of live (or waiting) sessions. */
    watchTargets: () => ({ dirs: hooksDir ? [hooksDir] : [], files: liveFiles }),

    async getItem(id) {
      const s = locate(id)
      const r = s && load(s)
      return r && { summary: withProcess(r.summary, openSessions()), lanes: r.lanes, events: r.events }
    },

    async getCalls(id, { lane, kind, q } = {}) {
      const s = locate(id)
      const r = s && load(s)
      if (!r) return []
      const needle = q ? String(q).toLowerCase() : null
      return r.calls.filter((c) =>
        (!lane || c.lane === lane) && (!kind || c.kind === kind) &&
        (!needle || `${c.name} ${c.summary} ${c.server ?? ""}`.toLowerCase().includes(needle)))
    },

    /**
     * Chat turns of one lane ("main" or "agent-<id>"), newest page by default: turns [max(0, end - limit), end)
     * where end is `before` (default: all). { lane, total, start, turns } or null for an unknown session or lane.
     */
    async getTurns(id, lane, { before, limit = 100 } = {}) {
      const s = locate(id)
      if (!s || typeof lane !== "string") return null
      const m = /^agent-([\w-]+)$/.exec(lane)
      const file = lane === "main" ? s.file : m ? join(root, s.slug, s.id, "subagents", `agent-${m[1]}.jsonl`) : null
      const c = file && confined(file)
      if (!c) return null
      const t = turned.get(c.real) ?? turned.set(c.real, createTail(turnsAcc, onParse))
      try { t.update(c.real, c.st) } catch { return null }
      const all = t.result()
      const end = Math.max(0, Math.min(all.length, Number.isInteger(before) ? before : all.length))
      const start = Math.max(0, end - Math.max(1, limit))
      return { lane, total: all.length, start, turns: all.slice(start, end) }
    },

    /** Per-turn tokens, cost and compaction markers of one lane ("main" or "agent-<id>"); null when unknown. */
    async getTurnCosts(id, lane = "main") {
      const s = locate(id)
      const d = s && parsed(s)
      if (!d) return null
      const p = lane === "main" ? d.mp : d.subs.find((a) => `agent-${a.aid}` === lane)?.p
      return p ? { lane, ...turnCosts(p.messages, costOf) } : null
    },

    /** Raw transcript text: "main.jsonl" (or "<id>.jsonl") or "agent-<id>.jsonl". Anything else is null. */
    async getSession(id, name) {
      if (!isSessionName(name)) return null
      const s = locate(id)
      if (!s) return null
      let file = null
      if (name === "main.jsonl" || name === `${s.id}.jsonl`) file = s.file
      else {
        const m = /^agent-([\w-]+)\.jsonl$/.exec(name)
        if (m) file = join(root, s.slug, s.id, "subagents", `agent-${m[1]}.jsonl`)
      }
      const c = file && confined(file)
      return c ? capText(head(c.real, SESSION_TEXT + 1, true), SESSION_TEXT) : null
    },

    /** Rows from the background scan; partial while `usageStatus().complete` is false. */
    async usage(range = {}) {
      scanner.kick()
      return scanner.rows(range)
    },
    usageStatus: () => scanner.status(),
    /** 15-minute token buckets since a bucket time, from the background scan (for the usage-window estimate). */
    async usageBuckets(since) {
      scanner.kick()
      return scanner.buckets({ since })
    },
    /** Resolves when the running usage scan (if any) has finished. */
    whenScanned: () => scanner.idle(),
    /** Server start: fill the list cache and begin the usage scan without blocking the caller. */
    async warm() {
      await new Promise((r) => setImmediate(r))
      try { await this.listItems() } catch { /* a bad file must not stop the scan */ }
      scanner.kick()
    },

    describe: () => ({ source: root }),
    /** The usage cache file (null: memory only). */
    usageCachePath: cachePath ?? null,
  }
}

export default create
