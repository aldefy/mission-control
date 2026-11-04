import { describe, expect, it } from "vitest"
import { latestPreview, qaActivity, runBanner } from "./run-banner"

describe("runBanner", () => {
  it("done: verified, or built with what nobody verified listed", () => {
    const h = { type: "handoff", branch: "ronin/x", verified: false, unverified: ["qa: share sheet"], assumed: ["backend: no flag"], questions: [{ stage: "backend", text: "flag?" }], findings: [{}] }
    expect(runBanner([{ type: "stage.start", stage: "qa" }, h], false)).toEqual({ kind: "done", verified: false, checked: false, branch: "ronin/x", unverified: ["qa: share sheet"], assumed: ["backend: no flag"], questions: ["backend: flag?"], findings: 1 })
    expect(runBanner([{ type: "handoff", verified: true }], false)).toMatchObject({ kind: "done", verified: true })
  })
  it("stopped: the last stop nothing cleared; a resume clears it", () => {
    const ev = [{ type: "stage.start", stage: "qa" }, { type: "stop", rule: "unverified", stage: "qa", detail: "E3" }]
    expect(runBanner(ev, false)).toEqual({ kind: "stopped", rule: "unverified", stage: "qa", detail: "E3" })
    expect(runBanner([...ev, { type: "run.resume" }], true)).toMatchObject({ kind: "running" })
  })
  it("running: the current stage and what it is doing; nothing when idle", () => {
    const ev = [{ type: "stage.start", stage: "backend" }, { type: "progress", stage: "backend", tool: "Bash", detail: "npm test" }]
    expect(runBanner(ev, true)).toEqual({ kind: "running", stage: "backend", doing: "Bash: npm test" })
    expect(runBanner(ev, false)).toBeNull()
  })
  it("latest preview and QA's latest round", () => {
    expect(latestPreview([{ type: "preview", png: "app/a.png", v: "1" }, { type: "preview", png: "app/preview.png", v: "2" }])).toEqual({ path: "app/preview.png", v: "2" })
    expect(latestPreview([])).toBeNull()
    const ev = [
      { type: "stage.start", stage: "qa" }, { type: "progress", stage: "qa", tool: "Bash", detail: "old" },
      { type: "stage.start", stage: "qa" }, { type: "progress", stage: "qa", tool: "session", detail: "id" },
      { type: "progress", stage: "qa", tool: "cp_device_interact", detail: "tap Save" },
      { type: "check", stage: "qa", cmd: "npm test", exitCode: 1 }, { type: "gap", detail: "E3 not checked" },
    ]
    expect(qaActivity(ev)).toEqual([{ kind: "cp_device_interact", text: "tap Save" }, { kind: "check", text: "npm test", ok: false }, { kind: "not verified", text: "E3 not checked", ok: false }])
  })
})

describe("runBanner: an agent asks", () => {
  it("a pending question or permission request comes first, until answered", () => {
    const q = { type: "question.asked", stage: "research", id: "f1", title: "Questions", fields: [{ key: "q0", title: "Focus", options: [{ value: "a" }] }, { foo: 1 }] }
    expect(runBanner([{ type: "stage.start", stage: "research" }, q], true)).toEqual({ kind: "asking", stage: "research", id: "f1", question: true, title: "Questions", fields: [{ key: "q0", title: "Focus", options: [{ value: "a" }] }] })
    expect(runBanner([q, { type: "question.answered", id: "f1" }], true)).toMatchObject({ kind: "running" })
    expect(runBanner([{ type: "approval.needed", stage: "qa", id: "p1", action: "bash", resources: ["ls"] }], true)).toEqual({ kind: "asking", stage: "qa", id: "p1", question: false, action: "bash", resources: ["ls"], message: null })
  })
})
