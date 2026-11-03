import { describe, expect, it } from "vitest"
import type { ItemSummary } from "@/lib/api"
import { pickTourItem, placeNote, tourSteps } from "./tour"

const item = (id: string, o: Partial<ItemSummary> = {}) =>
  ({ source: "claude-code", id, kind: "session", title: id, harness: "claude-code", cwd: "/w/app", branch: "main", live: false, status: "idle", waiting: false, startedAt: null, updatedAt: "2026-11-01T00:00:00Z", counts: { lanes: 1, calls: 0, errors: 0 }, ...o }) as ItemSummary

describe("pickTourItem", () => {
  it("prefers a live session with subagents, then live, then newest with subagents, then newest", () => {
    const old = item("old", { updatedAt: "2026-10-01T00:00:00Z" })
    const newest = item("newest", { updatedAt: "2026-11-03T00:00:00Z" })
    const subs = item("subs", { counts: { lanes: 3, calls: 9, errors: 0 } })
    const live = item("live", { live: true, status: "working" })
    const liveSubs = item("liveSubs", { live: true, status: "working", counts: { lanes: 2, calls: 99, errors: 0 } })
    expect(pickTourItem([old, newest, subs, live, liveSubs])?.id).toBe("liveSubs")
    expect(pickTourItem([old, newest, subs, live])?.id).toBe("live")
    expect(pickTourItem([old, newest, subs])?.id).toBe("subs")
    expect(pickTourItem([old, newest])?.id).toBe("newest")
  })
  it("skips hidden projects and copes with nothing", () => {
    expect(pickTourItem([item("h", { hidden: true, live: true })])).toBeNull()
    expect(pickTourItem(null)).toBeNull()
    expect(pickTourItem([])).toBeNull()
  })
})

describe("tourSteps", () => {
  it("writes the session steps with the session's own numbers", () => {
    const s = item("s1", { title: "Fix login", live: true, status: "working", counts: { lanes: 2, calls: 99, errors: 0 }, project: { key: "app", name: "app", worktree: "/w/app" }, branch: "feat/x" })
    const steps = tourSteps(s)
    const by = Object.fromEntries(steps.map((x) => [x.id, x]))
    expect(by.status.body).toContain('"Fix login" in app · feat/x')
    expect(by.status.body).toContain("working, the model or one of its tools is running right now")
    expect(by.status.body).toContain('"live" tag')
    expect(by.lanes.body).toContain("2 lanes")
    expect(by.lanes.body).toContain("1 subagent")
    expect(by.calls.body).toContain("Calls 99")
    expect(by.calls.body).toContain("main and subagents together")
    expect(by.map.go).toEqual({ view: "item", tab: "map" })
    expect(steps[0].id).toBe("welcome")
    expect(steps.at(-1)?.anchor).toBe("tour")
  })
  it("calls an idle session that waits for you Ready", () => {
    const body = tourSteps(item("r", { status: "idle", ready: true })).find((x) => x.id === "status")!.body
    expect(body).toContain("Ready, it finished and waits for your next prompt")
    expect(body).not.toContain('"live" tag')
  })
  it("leaves the session steps out when there is no session", () => {
    const ids = tourSteps(null).map((x) => x.id)
    expect(ids).toEqual(["welcome", "chips", "tree", "search", "palette", "freshness", "remote", "end"])
  })
  it("every anchored step names a data-tour anchor once", () => {
    const anchors = tourSteps(item("a", { counts: { lanes: 2, calls: 1, errors: 0 } })).flatMap((x) => (x.anchor ? [x.anchor] : []))
    expect(new Set(anchors).size).toBe(anchors.length)
  })
})

describe("placeNote", () => {
  const note = { width: 300, height: 150 }
  it("goes below the target when it fits, centred on it and inside the viewport", () => {
    expect(placeNote({ top: 40, left: 500, width: 200, height: 30 }, note, 1200, 800)).toEqual({ top: 82, left: 450 })
    expect(placeNote({ top: 40, left: 0, width: 100, height: 30 }, note, 1200, 800).left).toBe(12)
  })
  it("goes above when there is no room below, beside when neither fits", () => {
    expect(placeNote({ top: 700, left: 500, width: 200, height: 60 }, note, 1200, 800)).toEqual({ top: 538, left: 450 })
    expect(placeNote({ top: 20, left: 20, width: 240, height: 760 }, note, 1200, 800)).toEqual({ top: 20, left: 272 })
  })
  it("is centred with no target", () => {
    expect(placeNote(null, note, 1200, 800)).toEqual({ top: 325, left: 450 })
  })
})
