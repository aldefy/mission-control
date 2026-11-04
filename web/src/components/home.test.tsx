// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react"
import { afterEach, describe, expect, it } from "vitest"
import type { ItemSummary, LiveLane, NeedsYou } from "@/lib/api"
import { ItemTable, sortItems } from "./ItemTable"
import { LiveActivity } from "./LiveActivity"
import { NeedsYouQueue } from "./NeedsYouQueue"

afterEach(cleanup)

const item = (id: string, extra: Partial<ItemSummary> = {}): ItemSummary => ({
  source: "claude-code",
  id,
  kind: "session",
  title: `title ${id}`,
  harness: "claude-code",
  cwd: "/w/app",
  branch: "main",
  live: false,
  status: "done",
  waiting: false,
  startedAt: null,
  updatedAt: "2026-11-02T10:00:00.000Z",
  counts: { lanes: 1, calls: 0, errors: 0 },
  tokens: { in: 0, out: 0, cacheRead: 0, cacheWrite: 0 },
  cost: 0,
  project: { key: "app-1", name: "app", worktree: "/w/app" },
  ...extra,
})
const ask = (source: string, extra: Partial<NeedsYou> = {}): NeedsYou => ({
  source,
  id: `${source}-1`,
  title: "Approve answer to Q4",
  cwd: "/w/app",
  branch: "main",
  harness: source,
  updatedAt: "2026-11-02T09:58:00.000Z",
  project: { key: "app-1", name: "tipcalc", worktree: "/w/app" },
  lane: "qa",
  detail: "400 with code NEGATIVE_BILL",
  ...extra,
})

describe("NeedsYouQueue", () => {
  it("says nothing needs you when the queue is empty", () => {
    render(<NeedsYouQueue entries={[]} stopped={[]} actions={{}} />)
    expect(screen.getByText("Nothing needs you")).toBeTruthy()
    expect(screen.queryByText("Stopped")).toBeNull()
    expect(screen.getByRole("heading", { name: /Needs you/ }).textContent).toContain("0")
  })

  it("answer buttons when the source has actions, else an answer-in-terminal hint", () => {
    render(<NeedsYouQueue entries={[ask("ronin", { sign: true }), ask("claude-code")]} stopped={[]} actions={{ ronin: ["sign", "say"], "claude-code": [] }} />)
    const [ronin, cc] = screen.getAllByRole("article")
    expect(within(ronin).getByText("tipcalc · qa")).toBeTruthy()
    expect(within(ronin).getByRole("button", { name: "Sign" })).toBeTruthy()
    expect(within(ronin).getByRole("link", { name: "Answer…" }).getAttribute("href")).toBe("#/item/ronin/ronin-1/lanes")
    expect(within(ronin).queryByText(/answer in terminal/)).toBeNull()
    expect(within(cc).queryByRole("button")).toBeNull()
    expect(within(cc).getByText(/answer in terminal/)).toBeTruthy()
  })

  it("Sign only on a stop the source marks signable; any other question gets Answer only", () => {
    render(<NeedsYouQueue entries={[ask("ronin", { lane: "product", detail: "Which feature should this run build first?" })]} stopped={[]} actions={{ ronin: ["sign", "say"] }} />)
    const [ronin] = screen.getAllByRole("article")
    expect(within(ronin).queryByRole("button", { name: "Sign" })).toBeNull()
    expect(within(ronin).getByRole("link", { name: "Answer…" })).toBeTruthy()
  })

  it("lists stopped items under their own heading", () => {
    render(<NeedsYouQueue entries={[]} stopped={[item("s", { status: "stopped", title: "Budget: 3 rounds used" })]} actions={{}} />)
    expect(screen.getByText("Stopped")).toBeTruthy()
    expect(screen.getByText("Budget: 3 rounds used")).toBeTruthy()
  })
})

describe("ItemTable sorting", () => {
  const rows = [
    item("a", { title: "Bravo", cost: 0.5, updatedAt: "2026-11-02T08:00:00.000Z", counts: { lanes: 3, calls: 10, errors: 0 } }),
    item("b", { title: "alpha", cost: 2, updatedAt: "2026-11-02T09:00:00.000Z", counts: { lanes: 1, calls: 40, errors: 0 } }),
    item("c", { title: "Charlie", cost: 0, updatedAt: "2026-11-02T07:00:00.000Z", counts: { lanes: 2, calls: 5, errors: 0 }, status: "waiting" }),
  ]
  it("sortItems orders by any column, both ways; ties by newest", () => {
    expect(sortItems(rows, "updated", "desc").map((i) => i.id)).toEqual(["b", "a", "c"])
    expect(sortItems(rows, "title", "asc").map((i) => i.id)).toEqual(["b", "a", "c"])
    expect(sortItems(rows, "cost", "desc").map((i) => i.id)).toEqual(["b", "a", "c"])
    expect(sortItems(rows, "calls", "asc").map((i) => i.id)).toEqual(["c", "a", "b"])
    expect(sortItems(rows, "lanes", "desc").map((i) => i.id)).toEqual(["a", "c", "b"])
    expect(sortItems(rows, "status", "asc").map((i) => i.id)[0]).toBe("c") // needs you first
  })

  it("newest first by default; clicking a header sorts by it, clicking again flips", () => {
    render(<ItemTable items={rows} />)
    const titles = () => screen.getAllByRole("row").slice(1).map((r) => within(r).getAllByRole("cell")[0].textContent)
    expect(titles()).toEqual(["alpha", "Bravo", "Charlie"])
    fireEvent.click(screen.getByRole("button", { name: "Cost" }))
    expect(titles()).toEqual(["alpha", "Bravo", "Charlie"])
    expect(screen.getByRole("columnheader", { name: /Cost/ }).getAttribute("aria-sort")).toBe("descending")
    fireEvent.click(screen.getByRole("button", { name: "Cost" }))
    expect(titles()).toEqual(["Charlie", "Bravo", "alpha"])
    expect(screen.getByRole("columnheader", { name: /Cost/ }).getAttribute("aria-sort")).toBe("ascending")
    fireEvent.click(screen.getByRole("button", { name: "Title" }))
    expect(titles()).toEqual(["alpha", "Bravo", "Charlie"])
  })

  it("shows an empty state and caps long lists behind a show-all button", () => {
    render(<ItemTable items={[]} empty="No sessions here" />)
    expect(screen.getByText("No sessions here")).toBeTruthy()
    cleanup()
    render(<ItemTable items={Array.from({ length: 130 }, (_, i) => item(`n${i}`))} cap={100} />)
    expect(screen.getAllByRole("row")).toHaveLength(101)
    fireEvent.click(screen.getByRole("button", { name: "Show all 130" }))
    expect(screen.getAllByRole("row")).toHaveLength(131)
  })
  // minor 5: an unopened session (partial totals) shows "–", not 0 calls and $0.
  it("shows – for calls and cost of a session whose totals are not known yet", () => {
    render(<ItemTable items={[item("u", { partial: true }), item("o", { title: "opened", counts: { lanes: 1, calls: 7, errors: 0 } })]} />)
    const cells = (title: string) => within(screen.getByText(title).closest("tr")!).getAllByRole("cell").map((c) => c.textContent)
    // columns: title, where, harness, status, lanes, calls, cost, updated
    expect(cells("title u").slice(5, 7)).toEqual(["–", "–"])
    expect(cells("opened")[5]).toBe("7")
  })
})

describe("LiveActivity", () => {
  const lane = (id: string, ts: string): LiveLane => ({
    source: "claude-code",
    id,
    title: `session ${id}`,
    cwd: "/w/app",
    branch: "main",
    harness: "claude-code",
    updatedAt: ts,
    project: { key: "app-1", name: "app", worktree: "/w/app" },
    lane: "main",
    label: "main",
    kind: "main",
    model: "opus",
    nowDoing: { name: "Bash", kind: "tool", summary: "npm test", ts },
    startedAt: null,
  })
  it("one row per item, its working lanes nested as chips with a short command", () => {
    const at = "2026-11-02T09:59:48.000Z"
    render(
      <LiveActivity
        lanes={[
          lane("s1", at),
          { ...lane("s1", at), lane: "qa", label: "qa", nowDoing: { name: "Bash", kind: "tool", summary: "cd /Users/someone/work/app && npm run lint", ts: at } },
          lane("s2", at),
        ]}
        now={Date.parse("2026-11-02T10:00:00.000Z")}
      />,
    )
    const links = screen.getAllByRole("link")
    expect(links.map((l) => l.textContent)).toEqual(["session s1", "session s2"]) // one row per item
    expect(links[0].getAttribute("href")).toBe("#/item/claude-code/s1/lanes")
    const row = links[0].closest("li")!
    const chips = within(row).getAllByRole("listitem")
    expect(chips).toHaveLength(2)
    expect(row.textContent).toContain("2 lanes working")
    expect(chips[1].textContent).toContain("npm run lint")
    expect(chips[1].textContent).not.toContain("/Users/") // the cd prefix is gone; the full text is in the tooltip
    expect(within(chips[1]).getByLabelText(/qa \(opus\): Bash cd \/Users\/someone\/work\/app && npm run lint/)).toBeTruthy()
    expect(chips[0].textContent).toContain("12s")
  })
  it("a UUID-only title reads Untitled session · project · time", () => {
    render(<LiveActivity lanes={[{ ...lane("0b6f3a2e-1c4d-4e5f-9a8b-7c6d5e4f3a2b", "2026-11-02T09:59:48.000Z"), title: "0b6f3a2e-1c4d-4e5f-9a8b-7c6d5e4f3a2b" }]} />)
    expect(screen.getByRole("link").textContent).toMatch(/^Untitled session · app · \d\d:\d\d$/)
  })
  it("says so when nothing is running", () => {
    render(<LiveActivity lanes={[]} />)
    expect(screen.getByText("Nothing working right now")).toBeTruthy()
  })
})
