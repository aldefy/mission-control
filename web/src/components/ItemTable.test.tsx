// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react"
import { afterEach, describe, expect, it } from "vitest"
import type { ItemSummary } from "@/lib/api"
import { ItemTable } from "./ItemTable"

afterEach(cleanup)

const T = "2026-11-04T10:00:00.000Z"
const item = (extra: Partial<ItemSummary> = {}): ItemSummary => ({
  source: "claude-code", id: "s1", kind: "session", title: "Fix the flaky test", harness: "claude-code", cwd: "/w", branch: "main",
  live: false, status: "idle", waiting: false, startedAt: T, updatedAt: T, counts: { lanes: 1, calls: 2, errors: 0 },
  tokens: { in: 1, out: 1, cacheRead: 0, cacheWrite: 0 }, cost: 0.01, open: true, resume: "cd /w && claude --resume s1", ...extra,
})

describe("ItemTable", () => {
  it("row actions take no room until the row is hovered or focused, so the title keeps the Title column", () => {
    render(<ItemTable items={[item()]} />)
    expect(screen.getByRole("link", { name: "Fix the flaky test" })).toBeTruthy()
    for (const name of ["Rename", "Pin to the top", "Archive (hidden once it closes)"]) {
      const cls = screen.getByRole("button", { name }).className
      expect(cls).toMatch(/(^|\s)hidden(\s|$)/)
      expect(cls).toContain("group-hover:inline-flex")
      expect(cls).toContain("group-focus-within:inline-flex")
    }
  })

  it("a pinned row keeps its pin visible", () => {
    render(<ItemTable items={[item({ pinned: true })]} />)
    expect(screen.getByRole("button", { name: "Unpin" }).className).not.toMatch(/(^|\s)hidden(\s|$)/)
  })
})
