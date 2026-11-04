import { describe, expect, it } from "vitest"
import type { ItemSummary, ProjectSummary, StatusCounts, WorktreeSummary } from "./api"
import { doneToday, filterCount, filterTree, matchesFilter, paletteResults, rollup, rollupCounts, visibleProjects, worktreeLabel } from "./tree"

const item = (id: string, status: ItemSummary["status"], extra: Partial<ItemSummary> = {}): ItemSummary => ({
  source: "claude-code",
  id,
  kind: "session",
  title: `title ${id}`,
  harness: "claude-code",
  cwd: "/w/app",
  branch: "main",
  live: status === "working",
  status,
  waiting: status === "waiting",
  startedAt: null,
  updatedAt: "2026-11-02T10:00:00.000Z",
  counts: { lanes: 1, calls: 0, errors: 0 },
  tokens: { in: 0, out: 0, cacheRead: 0, cacheWrite: 0 },
  cost: 0,
  ...extra,
})

const counts = (c: Partial<StatusCounts> = {}): StatusCounts => ({ items: 0, live: 0, closed: 0, waiting: 0, looping: 0, working: 0, stopped: 0, failed: 0, done: 0, idle: 0, ...c })
const wt = (path: string, branch: string | null, c: Partial<StatusCounts>, extra: Partial<WorktreeSummary> = {}): WorktreeSummary => ({
  path,
  branch,
  live: !!c.live,
  waiting: !!c.waiting,
  counts: counts(c),
  doneToday: 0,
  updatedAt: null,
  ...extra,
})

const tree = (): ProjectSummary[] => [
  {
    key: "app-1",
    name: "app",
    path: "/w/app",
    worktrees: [
      wt("/w/app", "main", { items: 2, live: 1, working: 1, done: 1 }, { doneToday: 1 }),
      wt("/w/app-feat", "feat/login", { items: 1, waiting: 1 }),
      wt("/w/app-old", null, {}),
    ],
  },
  { key: "shop-2", name: "shop", path: "/w/shop", worktrees: [wt("/w/shop", "main", { items: 2, failed: 1, stopped: 1 })] },
  { key: "mem-3", name: "observer-sessions", path: "/h/.claude-mem/observer-sessions", hidden: true, worktrees: [wt("/h/.claude-mem/observer-sessions", null, { items: 9, done: 9 }, { doneToday: 4 })] },
]
const placed = (key: string, name: string, worktree: string) => ({ project: { key, name, worktree } })
const items = (): ItemSummary[] => [
  item("a", "working", placed("app-1", "app", "/w/app")),
  item("b", "done", placed("app-1", "app", "/w/app")),
  item("c", "waiting", { ...placed("app-1", "app", "/w/app-feat"), branch: "feat/login" }),
  item("d", "failed", { title: "Checkout flow", ...placed("shop-2", "shop", "/w/shop") }),
  item("e", "stopped", placed("shop-2", "shop", "/w/shop")),
]

describe("rollup", () => {
  it("needs-you beats working beats failed beats stopped beats done beats idle", () => {
    expect(rollup([item("a", "done"), item("b", "waiting"), item("c", "working")])).toBe("waiting")
    expect(rollup([item("a", "done"), item("c", "working")])).toBe("working")
    expect(rollup([item("a", "stopped"), item("c", "failed")])).toBe("failed")
    expect(rollup([item("a", "stopped"), item("c", "done")])).toBe("stopped")
    expect(rollup([item("a", "idle"), item("c", "done")])).toBe("done")
    expect(rollup([])).toBe("idle")
  })
  it("works the same over status counts", () => {
    expect(rollupCounts([counts({ done: 3 }), counts({ working: 1 })])).toBe("working")
    expect(rollupCounts([counts({ failed: 1, waiting: 1 })])).toBe("waiting")
    expect(rollupCounts([counts()])).toBe("idle")
  })
})

describe("matchesFilter", () => {
  const now = new Date("2026-11-02T18:00:00.000Z")
  it("stopped includes failed; done means done today in local time", () => {
    expect(matchesFilter(item("x", "failed"), "stopped", now)).toBe(true)
    expect(matchesFilter(item("x", "done"), "done", now)).toBe(true)
    expect(matchesFilter(item("x", "done", { updatedAt: "2026-10-20T10:00:00.000Z" }), "done", now)).toBe(false)
    expect(matchesFilter(item("x", "working"), null, now)).toBe(true)
  })
})

describe("doneToday and hidden projects", () => {
  it("sums the server's per-worktree done-today counts", () => {
    expect(doneToday(tree())).toBe(5)
    expect(doneToday(visibleProjects(tree(), false))).toBe(1)
  })
  it("hidden projects show only when asked", () => {
    expect(visibleProjects(tree(), false).map((p) => p.key)).toEqual(["app-1", "shop-2"])
    expect(visibleProjects(tree(), true)).toHaveLength(3)
  })
})

describe("filterCount", () => {
  it("stopped includes failed; done is done today", () => {
    const w = wt("/w", null, { items: 6, stopped: 1, failed: 2, done: 3, waiting: 1 }, { doneToday: 2 })
    expect(filterCount(w, null)).toBe(6)
    expect(filterCount(w, "stopped")).toBe(3)
    expect(filterCount(w, "done")).toBe(2)
    expect(filterCount(w, "waiting")).toBe(1)
  })
})

describe("filterTree", () => {
  it("no query and no filter keeps everything", () => {
    expect(filterTree(tree(), "", null)).toHaveLength(3)
  })
  it("a status filter keeps only worktrees with matching items, the count narrowed", () => {
    const t = filterTree(tree(), "", "waiting")
    expect(t.map((p) => p.key)).toEqual(["app-1"])
    expect(t[0].worktrees.map((w) => [w.path, w.counts.items])).toEqual([["/w/app-feat", 1]])
    expect(filterTree(tree(), "", "stopped")[0].worktrees[0].counts.items).toBe(2)
  })
  it("the query matches project name, branch or path, case-insensitive", () => {
    expect(filterTree(tree(), "SHOP", null).map((p) => p.key)).toEqual(["shop-2"])
    const t = filterTree(tree(), "login", null)
    expect(t.map((p) => p.key)).toEqual(["app-1"])
    expect(t[0].worktrees.map((w) => w.branch)).toEqual(["feat/login"])
  })
  it("a project-name hit keeps all its worktrees", () => {
    expect(filterTree(tree(), "app", null)[0].worktrees).toHaveLength(3)
  })
})

describe("worktreeLabel", () => {
  it("is the branch, else the folder name", () => {
    expect(worktreeLabel({ path: "/w/app-old", branch: null })).toBe("app-old")
    expect(worktreeLabel({ path: "/w/app", branch: "main" })).toBe("main")
    expect(worktreeLabel({ path: "", branch: null })).toBe("(no folder)")
  })
})

describe("paletteResults", () => {
  it("empty query lists pages, then projects, then needs-you and live items first", () => {
    const r = paletteResults(visibleProjects(tree(), false), items(), "")
    expect(r.slice(0, 2).map((x) => x.label)).toEqual(["Home", "Usage"])
    expect(r.filter((x) => x.kind === "project").map((x) => x.label)).toEqual(["app", "shop"])
    const found = r.filter((x) => x.kind === "item")
    expect(found[0].id).toBe("item:claude-code/c")
    expect(found[1].id).toBe("item:claude-code/a")
  })
  it("matches item titles and ids, and links items to their route", () => {
    const r = paletteResults(tree(), items(), "checkout")
    expect(r).toHaveLength(1)
    expect(r[0]).toMatchObject({ kind: "item", label: "Checkout flow", hint: "shop · main", href: "#/item/claude-code/d/lanes", status: "failed" })
  })
  it("keeps each kind together so group headers show once", () => {
    const kinds = paletteResults(tree(), items(), "w").map((x) => x.kind)
    expect(kinds).toContain("worktree")
    const runs = kinds.filter((k, i) => k !== kinds[i - 1])
    expect(runs).toEqual([...new Set(runs)])
  })
  it("caps the list", () => {
    const many = Array.from({ length: 300 }, (_, i) => item(`n${i}`, "done"))
    expect(paletteResults(tree(), many, "title").length).toBeLessThanOrEqual(50)
  })
})
