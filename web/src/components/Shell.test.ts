import { describe, expect, it } from "vitest"
import type { ItemSummary, ProjectSummary } from "@/lib/api"
import { crumbs, footerNote } from "./Shell"
import { chipCounts } from "./StatusChips"

describe("shell footer (M5)", () => {
  it("is read-only with no actions, else read-only except your actions", () => {
    expect(footerNote([])).toBe("read-only · local · 127.0.0.1")
    expect(footerNote(undefined)).toBe("read-only · local · 127.0.0.1")
    expect(footerNote(["sign", "say"])).toBe("read-only except your actions · local · 127.0.0.1")
  })
})

const projects = [
  {
    key: "app-1",
    name: "app",
    path: "/w/app",
    worktrees: [{ path: "/w/app-feat", branch: "feat/x", live: false, waiting: false }],
  },
] as unknown as ProjectSummary[]
const s1 = { source: "claude-code", id: "s1", title: "Fix login", branch: "feat/x", project: { key: "app-1", name: "app", worktree: "/w/app-feat" } } as unknown as ItemSummary

describe("crumbs", () => {
  it("names an item by project, worktree and title, with links up the tree", () => {
    expect(crumbs({ view: "item", source: "claude-code", id: "s1", tab: "lanes" }, projects, s1)).toEqual([
      { label: "home", href: "#/" },
      { label: "app", href: "#/project/app-1" },
      { label: "feat/x", href: `#/worktree/app-1/${encodeURIComponent("/w/app-feat")}` },
      { label: "Fix login" },
    ])
  })
  it("falls back to raw keys before the tree loads", () => {
    expect(crumbs({ view: "project", key: "app-1" }, [])).toEqual([{ label: "home", href: "#/" }, { label: "app-1" }])
    expect(crumbs({ view: "item", source: "native", id: "r1", tab: "lanes" }, []).at(-1)).toEqual({ label: "native · r1" })
  })
})

describe("chipCounts", () => {
  it("shows a dash until the overview loads; done is today's count", () => {
    expect(chipCounts(null, 2)).toEqual({ waiting: null, looping: null, ready: null, working: null, stopped: null, done: 2, closed: null })
    expect(chipCounts({ counts: { waiting: 1, working: 2, stopped: 3, done: 40, closed: 5 }, needsYou: [], live: [], hidden: 0 }, 0)).toEqual({ waiting: 1, looping: 0, ready: 0, working: 2, stopped: 3, done: 0, closed: 5 })
  })
})
