import { execFile } from "node:child_process"
import { createHash } from "node:crypto"
import { existsSync, realpathSync } from "node:fs"
import { basename, dirname, isAbsolute, resolve } from "node:path"

const GIT_TIMEOUT_MS = 4000
const STATUS_TTL_MS = 30_000
const CONCURRENCY = 8

// No fsmonitor daemon or hook of the inspected repo may run: its config is untrusted input.
const GIT_FLAGS = ["-c", "core.fsmonitor=false", "-c", "core.hooksPath=/dev/null"]

function exec(args, cwd) {
  return new Promise((done) => {
    execFile("git", args, {
      cwd, timeout: GIT_TIMEOUT_MS, maxBuffer: 16 * 1024 * 1024,
      env: { ...process.env, GIT_OPTIONAL_LOCKS: "0", GIT_TERMINAL_PROMPT: "0" },
    }, (err, stdout) => done(err ? null : String(stdout)))
  })
}

/**
 * Read-only git with per-path caches. A located repo never changes for a cwd (kept for good); a miss
 * (not a repo yet, or git failed) is retried after `ttl` ms. Worktree lists and status/ahead/behind are
 * stale-while-revalidate: once loaded they are returned at once, and past `ttl` a background refresh
 * replaces them for the next call. Every method resolves, never rejects. `exec(args, cwd)` is injectable.
 * Interface (a test can stub it): resolve(cwd) -> { commonDir, toplevel } | null,
 * worktrees(commonDir) -> [{ path, branch }] | null, status(path) -> { dirty, ahead?, behind? } | null.
 */
export function createGit({ ttl = STATUS_TTL_MS, now = () => Date.now(), exec: execImpl = exec } = {}) {
  const run = (args, cwd) => execImpl([...GIT_FLAGS, ...args], cwd)
  const located = new Map() // cwd -> { promise, at, miss }
  const timed = new Map() // key -> { at, promise, settled, refreshing }
  const fresh = (key, load) => {
    const hit = timed.get(key)
    if (!hit) {
      const e = { at: now(), promise: null, settled: undefined, refreshing: false }
      e.promise = load().then((v) => { e.settled = v; return v }, () => { e.settled = null; return null })
      timed.set(key, e)
      return e.promise
    }
    if (now() - hit.at < ttl) return hit.promise
    if (!hit.refreshing) {
      hit.refreshing = true
      load().then((v) => { if (v !== null) { hit.settled = v; hit.promise = Promise.resolve(v) } }, () => {}).finally(() => { hit.at = now(); hit.refreshing = false })
    }
    return hit.settled !== undefined ? Promise.resolve(hit.settled) : hit.promise
  }
  return {
    resolve(cwd) {
      const hit = located.get(cwd)
      if (hit && !(hit.miss && now() - hit.at >= ttl)) return hit.promise
      const e = { at: now(), miss: false, promise: null }
      e.promise = (async () => {
        if (!isAbsolute(cwd) || !existsSync(cwd)) return null
        const out = await run(["rev-parse", "--git-common-dir", "--show-toplevel"], cwd)
        const [common, top] = (out ?? "").split("\n")
        if (!common || !top) return null
        try { return { commonDir: realpathSync(resolve(cwd, common)), toplevel: realpathSync(top) } } catch { return null }
      })().then((v) => { e.miss = v === null; return v })
      located.set(cwd, e)
      return e.promise
    },
    worktrees: (commonDir) => fresh(`wt|${commonDir}`, async () => {
      const out = await run(["worktree", "list", "--porcelain"], commonDir)
      if (out === null) return null
      const list = []
      for (const block of out.split("\n\n")) {
        const path = /^worktree (.+)$/m.exec(block)?.[1]
        if (!path) continue
        const branch = /^branch refs\/heads\/(.+)$/m.exec(block)?.[1] ?? null
        let real = path
        try { real = realpathSync(path) } catch { continue } // a pruned worktree whose directory is gone
        list.push({ path: real, branch })
      }
      return list
    }),
    status: (path) => fresh(`st|${path}`, async () => {
      const st = await run(["status", "--porcelain"], path)
      if (st === null) return null
      const r = { dirty: st.split("\n").filter(Boolean).length }
      const ab = await run(["rev-list", "--left-right", "--count", "@{u}...HEAD"], path) // fails without an upstream
      const m = /^(\d+)\s+(\d+)/.exec(ab ?? "")
      if (m) { r.behind = Number(m[1]); r.ahead = Number(m[2]) }
      return r
    }),
  }
}

export const realGit = createGit()

/** "<folder name>-<8 hex of identity>": readable in URLs, unique per identity (a cwd or a git common dir). */
const keyOf = (name, identity = name) => `${basename(name).replace(/[^\w.-]/g, "_") || "root"}-${createHash("sha1").update(identity).digest("hex").slice(0, 8)}`
const NO_PROJECT = "no-project"

/** Key, name and path of the project a cwd belongs to, given its git location (or null). */
function projectInfo(cwd, loc) {
  if (loc) {
    const path = basename(loc.commonDir) === ".git" ? dirname(loc.commonDir) : loc.commonDir
    // Named after the main checkout's folder (the toplevel of the main worktree), hashed on the common dir.
    return { key: keyOf(path, loc.commonDir), name: basename(path), path }
  }
  if (cwd) return { key: keyOf(cwd), name: basename(cwd) || cwd, path: cwd }
  return { key: NO_PROJECT, name: "(no project)", path: "" }
}

/** cwd -> { key, name, path, worktree } for each distinct cwd, using the same keys and worktree paths as buildTree. */
export async function projectsOf(cwds, { git = realGit } = {}) {
  const list = [...new Set(cwds.filter((c) => typeof c === "string" && c))]
  const out = new Map()
  await pool(list, async (cwd) => {
    let loc = null
    try { loc = await git.resolve(cwd) } catch { /* fall back to the cwd */ }
    const { key, name, path } = projectInfo(cwd, loc)
    out.set(cwd, { key, name, path, worktree: loc ? loc.toplevel : cwd })
  })
  return out
}

async function pool(list, fn) {
  let i = 0
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, list.length) }, async () => {
    while (i < list.length) await fn(list[i++])
  }))
}

/**
 * Group items by project (the git common dir of their cwd) and worktree. Items whose cwd is missing or
 * not a git repo fall back to a project at the cwd itself. Git failures never throw.
 * `only` (a project key) keeps just that project: other items are dropped before any worktree or status call.
 */
export async function buildTree(items, { git = realGit, only } = {}) {
  const cwds = [...new Set(items.map((i) => i.cwd).filter((c) => typeof c === "string" && c))]
  const where = new Map()
  await pool(cwds, async (cwd) => {
    try { where.set(cwd, await git.resolve(cwd)) } catch { where.set(cwd, null) }
  })

  const projects = new Map()
  const project = (key, name, path) => {
    if (!projects.has(key)) projects.set(key, { key, name, path, worktrees: new Map(), common: null })
    return projects.get(key)
  }
  const worktree = (p, path, branch) => {
    if (!p.worktrees.has(path)) p.worktrees.set(path, { path, branch: branch ?? null, items: [], live: false, waiting: false })
    const w = p.worktrees.get(path)
    w.branch ??= branch ?? null
    return w
  }

  for (const item of items) {
    const loc = item.cwd ? where.get(item.cwd) : null
    const info = projectInfo(item.cwd, loc)
    if (only !== undefined && info.key !== only) continue
    const p = project(info.key, info.name, info.path)
    let w
    if (loc) {
      p.common = loc.commonDir
      w = worktree(p, loc.toplevel, null)
    } else if (item.cwd) w = worktree(p, item.cwd, item.branch)
    else w = worktree(p, "", item.branch)
    w.items.push(item)
    w.live ||= !!item.live
    w.waiting ||= !!item.waiting || item.status === "waiting"
  }

  // Linked worktrees with no sessions yet, and each worktree's branch.
  const gitProjects = [...projects.values()].filter((p) => p.common)
  await pool(gitProjects, async (p) => {
    try {
      for (const t of (await git.worktrees(p.common)) ?? []) worktree(p, t.path, t.branch)
      for (const w of p.worktrees.values()) if (w.branch == null) w.branch = w.items.find((i) => i.branch)?.branch ?? null
    } catch { /* keep the worktrees the items imply */ }
  })
  const gitWorktrees = gitProjects.flatMap((p) => [...p.worktrees.values()])
  await pool(gitWorktrees, async (w) => {
    try {
      const s = await git.status(w.path)
      if (s) { w.dirty = s.dirty; if (s.ahead !== undefined) { w.ahead = s.ahead; w.behind = s.behind } }
    } catch { /* no status for this worktree */ }
  })

  const newest = (w) => w.items.reduce((m, i) => (String(i.updatedAt ?? "") > m ? String(i.updatedAt) : m), "")
  return [...projects.values()].map((p) => {
    const worktrees = [...p.worktrees.values()]
    for (const w of worktrees) w.items.sort((a, b) => String(b.updatedAt ?? "").localeCompare(String(a.updatedAt ?? "")))
    worktrees.sort((a, b) => newest(b).localeCompare(newest(a)) || a.path.localeCompare(b.path))
    return { key: p.key, name: p.name, path: p.path, worktrees }
  }).sort((a, b) => Math.max(...b.worktrees.map((w) => +!!w.live)) - Math.max(...a.worktrees.map((w) => +!!w.live)) ||
    newest(b.worktrees[0]).localeCompare(newest(a.worktrees[0])) || a.name.localeCompare(b.name))
}

/** Where an item with no usable cwd is filed (matches buildTree's fallback). */
export const NO_PROJECT_INFO = Object.freeze({ key: NO_PROJECT, name: "(no project)", path: "", worktree: "" })

const STATUSES = ["waiting", "looping", "working", "stopped", "failed", "done", "idle"]

/** The day of `ts` in zone `tz` (YYYY-MM-DD), or null. */
const dayIn = (ts, tz) => {
  const d = new Date(ts)
  return Number.isFinite(d.getTime()) ? d.toLocaleDateString("en-CA", { timeZone: tz }) : null
}

/**
 * Per-worktree counts by status, live count, done-today (in `tz`) and newest update; `hidden` on noise
 * projects (`isHidden(project)`). `slim` drops the item lists, leaving what the sidebar and chips need.
 */
export function shapeTree(tree, { tz = "UTC", now = Date.now(), slim = false, isHidden = () => false } = {}) {
  const today = dayIn(now, tz)
  return tree.map((p) => {
    const worktrees = p.worktrees.map((w) => {
      const counts = { items: w.items.length, live: 0, ready: 0, closed: 0 }
      for (const s of STATUSES) counts[s] = 0
      let doneToday = 0, updatedAt = null
      for (const i of w.items) {
        if (i.live) counts.live++
        if (i.ready && i.status !== "waiting") counts.ready++
        if (i.open === false) counts.closed++ // also counted in its status (idle)
        if (STATUSES.includes(i.status)) counts[i.status]++
        if (i.status === "done" && i.updatedAt && dayIn(i.updatedAt, tz) === today) doneToday++
        if (i.updatedAt && (!updatedAt || String(i.updatedAt) > updatedAt)) updatedAt = String(i.updatedAt)
      }
      const { items, ...rest } = w
      return { ...rest, ...(slim ? {} : { items }), counts, doneToday, updatedAt }
    })
    return { ...p, ...(isHidden(p) ? { hidden: true } : {}), worktrees }
  })
}
