import { test } from "node:test"
import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { askText, openAsk, openStop, isWaiting } from "../src/status.mjs"
import { fromAdapter } from "../src/sources/from-adapter.mjs"

const stop = (rule) => ({ type: "stop", stage: "qa", rule, detail: "d" })

test("an owner stop waits until stage.start, human.input, run.resume or run.start", () => {
  assert.equal(isWaiting([{ type: "stage.start", stage: "qa" }, stop("human")]), true)
  for (const type of ["stage.start", "human.input", "run.resume", "run.start"]) {
    assert.equal(openStop([stop("human"), { type }]), null, type)
    assert.equal(isWaiting([stop("human"), { type }]), false, type)
  }
})

test("bookkeeping after a stop (run.end, published, progress) does not clear it", () => {
  for (const type of ["run.end", "published", "progress", "stage.end", "session"]) {
    assert.equal(isWaiting([stop("human"), { type, status: "stopped" }]), true, type)
  }
})

test("any other rule is stopped, not waiting; the last stop wins", () => {
  assert.equal(isWaiting([stop("budget")]), false)
  assert.equal(openStop([stop("budget")]).rule, "budget")
  assert.equal(isWaiting([stop("budget"), stop("human")]), true)
  assert.equal(isWaiting([stop("human"), stop("budget")]), false)
  assert.equal(isWaiting([stop(undefined)]), false)
})

test("empty, missing and junk events", () => {
  assert.equal(openStop(null), null)
  assert.equal(isWaiting([]), false)
  assert.equal(isWaiting([null, 7, "x", stop("human")]), true)
})

test("status.mjs has no node: imports", () => {
  assert.doesNotMatch(readFileSync(new URL("../src/status.mjs", import.meta.url), "utf8"), /(?:from\s+|import\s*\(?\s*)["']node:/)
})

const ask = { type: "question.asked", stage: "research", id: "f1", title: "Questions", fields: [{ key: "q0", title: "Decision", description: "Which decision should this inform? It changes depth." }, { key: "q1", title: "Sources" }] }

test("an unverified stop waits on you like a human one; budget does not", () => {
  assert.equal(isWaiting([stop("unverified")]), true)
  assert.equal(isWaiting([stop("budget")]), false)
})

test("an agent's question or permission request waits on you until answered, its stage ends, or the run restarts", () => {
  assert.equal(openAsk([{ type: "stage.start", stage: "research" }, ask]).id, "f1")
  assert.equal(isWaiting([ask]), true)
  assert.equal(isWaiting([ask, { type: "question.answered", stage: "research", id: "f1" }]), false)
  assert.equal(isWaiting([ask, { type: "stage.end", stage: "research" }]), false)
  assert.equal(isWaiting([ask, { type: "stage.end", stage: "other" }]), true)
  assert.equal(isWaiting([ask, { type: "run.resume" }]), false)
  const perm = { type: "approval.needed", stage: "backend", id: "p1", action: "bash", resources: ["rm -rf build"] }
  assert.equal(isWaiting([perm]), true)
  assert.equal(isWaiting([perm, { type: "approval", id: "p1", decision: "once" }]), false)
  assert.equal(askText(ask), "asks 2 questions: Which decision should this inform?")
  assert.equal(askText(perm), "wants to bash: rm -rf build")
})

test("a run whose agent asks something is waiting, with the question as its lane's reason", async () => {
  const events = [{ type: "run.start" }, { type: "stage.start", stage: "research" }, { ...ask, ts: "2026-11-04T10:42:50Z" }]
  const src = fromAdapter({ name: "r", listRuns: async () => [{ id: "r1" }], getRun: async () => ({ id: "r1", state: { stages: { research: { status: "running" } } }, events, status: "running", live: true }), getSession: async () => null })
  const item = await src.getItem("r1")
  assert.equal(item.summary.status, "waiting")
  const lane = item.lanes.find((l) => l.id === "research")
  assert.equal(lane.status, "waiting")
  assert.equal(lane.reason, "research asks 2 questions: Which decision should this inform?")
})

test("an ask is no longer open once its answer is saved in state, or the run ended", () => {
  assert.equal(isWaiting([ask], { answers: { f1: { q0: "a" } } }), false)
  assert.equal(isWaiting([ask], { answers: { other: {} } }), true)
  assert.equal(isWaiting([ask, { type: "run.end", status: "done" }]), false)
})
