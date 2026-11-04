import type { ItemSummary, ProjectSummary, Status, StatusCounts, WorktreeSummary } from "./api"
import { toHash } from "./route"

/** The status chips' filters. `stopped` covers failed too; `done` means done today; `ready` is idle and waiting for your next prompt; `closed` has no running process. */
export type ChipFilter = "waiting" | "looping" | "ready" | "working" | "stopped" | "done" | "closed"

const RANK: Status[] = ["waiting", "looping", "working", "failed", "stopped", "done", "idle"]

/** One status for a group of items: the most urgent one present. */
export function rollup(items: Pick<ItemSummary, "status">[]): Status {
  let best = RANK.length - 1
  for (const i of items) {
    const r = RANK.indexOf(i.status)
    if (r >= 0 && r < best) best = r
  }
  return RANK[best]
}

/** The same order over a worktree's (or several worktrees') status counts. */
export function rollupCounts(counts: Pick<StatusCounts, Status>[]): Status {
  for (const s of RANK) if (counts.some((c) => c[s] > 0)) return s
  return "idle"
}

const localDay = (d: Date) => d.toLocaleDateString("en-CA")

export function matchesFilter(i: ItemSummary, f: ChipFilter | null, now = new Date()): boolean {
  if (!f) return true
  if (f === "ready") return !!i.ready && i.status !== "waiting"
  if (f === "stopped") return i.status === "stopped" || i.status === "failed"
  if (f === "closed") return i.open === false
  if (f === "done") return i.status === "done" && !!i.updatedAt && localDay(new Date(i.updatedAt)) === localDay(now)
  return i.status === f
}

/** How many of a worktree's items a chip filter keeps (done = done today, counted by the server in the viewer's zone). */
export function filterCount(w: Pick<WorktreeSummary, "counts" | "doneToday">, f: ChipFilter | null): number {
  if (!f) return w.counts.items
  if (f === "ready") return w.counts.ready ?? 0
  if (f === "stopped") return w.counts.stopped + w.counts.failed
  if (f === "closed") return w.counts.closed ?? 0
  if (f === "done") return w.doneToday
  return w.counts[f]
}

export function doneToday(projects: ProjectSummary[]): number {
  let n = 0
  for (const p of projects) for (const w of p.worktrees) n += w.doneToday
  return n
}

/** Projects the sidebar, chips and Home show: hidden (noise) ones only when asked. */
export const visibleProjects = <P extends Pick<ProjectSummary, "hidden">>(projects: P[], showHidden: boolean) =>
  showHidden ? projects : projects.filter((p) => !p.hidden)

const base = (path: string) => path.split(/[\\/]/).filter(Boolean).pop() ?? ""
export const worktreeLabel = (w: Pick<WorktreeSummary, "path" | "branch">) => w.branch || base(w.path) || "(no folder)"

/**
 * The tree narrowed by a text query (project name/path, worktree branch/path) and a chip filter: a
 * worktree stays when the filter keeps any of its items, and its `counts.items` becomes that number.
 */
export function filterTree(projects: ProjectSummary[], query: string, f: ChipFilter | null): ProjectSummary[] {
  const q = query.trim().toLowerCase()
  const has = (s: string | null | undefined) => !!s && s.toLowerCase().includes(q)
  const out: ProjectSummary[] = []
  for (const p of projects) {
    const projectHit = !q || has(p.name) || has(p.path)
    const worktrees: WorktreeSummary[] = []
    for (const w of p.worktrees) {
      if (!projectHit && !has(w.branch) && !has(w.path)) continue
      if (!f) {
        worktrees.push(w)
        continue
      }
      const n = filterCount(w, f)
      if (n) worktrees.push({ ...w, counts: { ...w.counts, items: n } })
    }
    if (worktrees.length) out.push({ ...p, worktrees })
  }
  return out
}

export type PaletteEntry = {
  id: string
  kind: "page" | "project" | "worktree" | "item"
  label: string
  hint: string
  href: string
  status?: Status
  live?: boolean
}

const PAGES: PaletteEntry[] = [
  { id: "page:home", kind: "page", label: "Home", hint: "needs you, live activity, recent", href: toHash({ view: "home" }) },
  { id: "page:usage", kind: "page", label: "Usage", hint: "tokens and cost", href: toHash({ view: "usage" }) },
]
const LIMIT = 50

const urgency = (i: ItemSummary) => (i.status === "waiting" ? 0 : i.live ? 1 : 2)

/**
 * ⌘K results: pages, projects, worktrees (only when searching) and items, needs-you and live items
 * first. Items come from /api/items (each placed in its project); the tree has no item lists.
 */
export function paletteResults(projects: ProjectSummary[], items: ItemSummary[], query: string): PaletteEntry[] {
  const q = query.trim().toLowerCase()
  const hit = (...s: (string | null | undefined)[]) => !q || s.some((x) => !!x && x.toLowerCase().includes(q))
  const out: PaletteEntry[] = PAGES.filter((p) => hit(p.label))
  const worktrees: PaletteEntry[] = []
  const labels = new Map<string, string>() // worktree path -> label
  for (const p of projects) {
    if (hit(p.name, p.path)) {
      const st = rollupCounts(p.worktrees.map((w) => w.counts))
      out.push({ id: `project:${p.key}`, kind: "project", label: p.name, hint: p.path, href: toHash({ view: "project", key: p.key }), status: st })
    }
    for (const w of p.worktrees) {
      const label = worktreeLabel(w)
      labels.set(`${p.key}|${w.path}`, label)
      if (q && hit(w.branch, w.path))
        worktrees.push({
          id: `worktree:${p.key}:${w.path}`,
          kind: "worktree",
          label: `${p.name} · ${label}`,
          hint: w.path,
          href: toHash({ view: "worktree", key: p.key, path: w.path }),
          status: rollupCounts([w.counts]),
        })
    }
  }
  out.push(...worktrees)
  const found = items.filter((i) => hit(i.title, i.id))
  found.sort((a, b) => urgency(a) - urgency(b) || String(b.updatedAt ?? "").localeCompare(String(a.updatedAt ?? "")))
  for (const i of found) {
    if (out.length >= LIMIT) break
    const pl = i.project
    const wt = pl ? (labels.get(`${pl.key}|${pl.worktree}`) ?? (i.branch || base(pl.worktree))) : i.branch
    out.push({
      id: `item:${i.source}/${i.id}`,
      kind: "item",
      label: i.title || i.id,
      hint: [pl?.name, wt].filter(Boolean).join(" · "),
      href: toHash({ view: "item", source: i.source, id: i.id, tab: "lanes" }),
      status: i.status,
      live: i.live,
    })
  }
  return out.slice(0, LIMIT)
}
