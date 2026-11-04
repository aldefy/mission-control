import { describe, expect, it } from "vitest"
import { readFileSync, readdirSync, statSync } from "node:fs"
import { join } from "node:path"
import { STATUS_UI, workingLine } from "./status-ui"

const SRC = join(import.meta.dirname, "..")
function files(dir: string): string[] {
  return readdirSync(dir).flatMap((f) => {
    const p = join(dir, f)
    return statSync(p).isDirectory() ? files(p) : /\.tsx?$/.test(f) && !/\.test\./.test(f) ? [p] : []
  })
}

describe("one status map", () => {
  it("has one word per status, from the plan's vocabulary", () => {
    expect(Object.fromEntries(Object.entries(STATUS_UI).map(([k, v]) => [k, v.label]))).toEqual({
      working: "working", waiting: "needs you", looping: "looping", failed: "failed", stopped: "stopped", done: "done", idle: "idle",
    })
  })
  it("every status has a distinct icon (status never relies on colour alone)", () => {
    expect(new Set(Object.values(STATUS_UI).map((u) => u.icon)).size).toBe(7)
  })
  it("looping has its own colour, distinct from failed and needs you", () => {
    expect(STATUS_UI.looping.text).toBe("text-looping")
    expect(STATUS_UI.looping.fill).toBe("bg-looping")
    expect(STATUS_UI.looping.text).not.toBe(STATUS_UI.failed.text)
    expect(STATUS_UI.looping.text).not.toBe(STATUS_UI.waiting.text)
  })
  it("the header line counts items working and their lanes in one place", () => {
    const l = (id: string) => ({ source: "s", id })
    expect(workingLine([])).toBe("idle")
    expect(workingLine([l("a")])).toBe("1 lane working · 1 item")
    expect(workingLine([l("a"), l("a"), l("b")])).toBe("3 lanes working · 2 items")
  })
  it("no component uses the retired words or mixes live into the status pill", () => {
    const bad = /waiting on you|waits on you|LIVE · needs you|working now/i
    const hits = files(SRC).filter((f) => !f.endsWith("status-ui.ts")).flatMap((f) =>
      readFileSync(f, "utf8").split("\n").map((l, i) => [f.slice(SRC.length + 1), i + 1, l] as const).filter(([, , l]) => bad.test(l) && !/^\s*(\/\/|\*|\/\*)/.test(l)),
    )
    expect(hits.map(([f, n]) => `${f}:${n}`)).toEqual([])
  })
  it("amber (needs-you) colours only needs-you things", () => {
    // allowed: status maps, needs-you cards/queue, waits, the map's you node and needs-you arrows/markers
    const ok = /status-ui|StatusChips|NeedsYou|LaneCards|ItemMap|FlowStrip|Findings|Thread|Trace|Sidebar|WorktreeCard|LaneSheet|StageBar|DriftPanel|events\.ts|Agent|Project\.tsx|ProjectPage|remote\/Prompt|RunBanner|globals/
    const hits = files(SRC).filter((f) => !ok.test(f)).flatMap((f) =>
      readFileSync(f, "utf8").split("\n").map((l, i) => `${f.slice(SRC.length + 1)}:${i + 1}`).filter((_, i) => /(text|bg|border|ring|stroke|fill|shadow)-needs-you/.test(readFileSync(f, "utf8").split("\n")[i])),
    )
    expect(hits).toEqual([])
  })
})
