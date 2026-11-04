import { describe, expect, it } from "vitest"
import { crewCards, crewGraph, currentStop, readDocs } from "./graph"

describe("crewGraph", () => {
  it("lays stages out left to right with flow between neighbours", () => {
    const g = crewGraph({ stages: { a: { status: "done" }, b: { status: "running" }, c: { status: "pending" } } }, [])
    expect(g.nodes.map((n) => n.id)).toEqual(["a", "b", "c"])
    expect(g.nodes[0].x).toBeLessThan(g.nodes[1].x)
    expect(g.nodes[1].x).toBeLessThan(g.nodes[2].x)
    expect(g.nodes.every((n) => n.x >= 0 && n.x <= 1000)).toBe(true)
    expect(g.flow).toEqual([["a", "b"], ["b", "c"]])
    expect(g.consult).toEqual([])
  })

  it("uses state.graph when the harness supplies one", () => {
    const graph = {
      nodes: [
        { id: "prep", label: "prep", x: 85, y: 330, stages: ["setup", "hooks"] },
        { id: "qa", label: "qa", x: 915, y: 330, stages: ["qa"] },
      ],
      flow: [["prep", "qa"]],
      consult: [["qa", "prep"]],
    }
    const g = crewGraph({ stages: { setup: { status: "done" } }, graph }, [])
    expect(g.nodes).toEqual(graph.nodes)
    expect(g.flow).toEqual(graph.flow)
    expect(g.consult).toEqual(graph.consult)
  })

  it("turns a blocking issue owned by another stage into a sendback hop", () => {
    const events = [
      { ts: "2026-11-01T09:10:00Z", type: "issue", stage: "qa", decision: { owner: "backend", blocks: true } },
      { ts: "2026-11-01T09:11:00Z", type: "issue", stage: "qa", decision: { owner: "qa", blocks: true } },
      { ts: "2026-11-01T09:12:00Z", type: "issue", stage: "qa", decision: { owner: "frontend", blocks: false } },
    ]
    const g = crewGraph({ stages: { backend: {}, qa: {} } }, events)
    expect(g.hops).toEqual([{ from: "qa", to: "backend", kind: "sendback", ts: "2026-11-01T09:10:00Z" }])
  })

  it("turns consult.asked into a consult hop labelled with its id", () => {
    const g = crewGraph({ stages: {} }, [
      { ts: "t1", type: "consult.asked", id: "Q4", from: "backend", to: "architect", question: "400 or 422?" },
    ])
    expect(g.hops).toEqual([{ from: "backend", to: "architect", kind: "consult", ts: "t1", label: "Q4" }])
  })

  it("adds stages that only appear in events after the state's stages", () => {
    const g = crewGraph({ stages: { setup: {} } }, [{ type: "stage.start", stage: "spec" }, { type: "progress", stage: "spec" }])
    expect(g.nodes.map((n) => n.id)).toEqual(["setup", "spec"])
  })
})

describe("currentStop", () => {
  it("is the last stop until the run resumes", () => {
    const stop = { ts: "t2", type: "stop", stage: "qa", rule: "human", detail: "copy?" }
    expect(currentStop({ stages: {} }, [{ type: "run.start" }, stop])).toMatchObject({ stage: "qa", rule: "human", detail: "copy?" })
    expect(currentStop({ stages: {} }, [stop, { type: "run.resume" }])).toBeNull()
  })
  it("uses the shared rule: human.input, stage.start and run.start clear it; only rule human waits", () => {
    const stop = { ts: "t2", type: "stop", stage: "qa", rule: "human", detail: "copy?" }
    expect(currentStop({}, [stop])).toMatchObject({ waiting: true })
    for (const type of ["human.input", "stage.start", "run.start"]) expect(currentStop({}, [stop, { type }])).toBeNull()
    expect(currentStop({}, [stop, { type: "run.end", status: "stopped" }])).toMatchObject({ waiting: true })
    expect(currentStop({}, [{ ...stop, rule: "budget" }])).toMatchObject({ rule: "budget", waiting: false })
  })
  it("does not invent a stop from the state alone", () => {
    expect(currentStop({ stages: { qa: { status: "stopped" } } }, [])).toBeNull()
  })
})

describe("crewCards", () => {
  it("sorts nodes into needs-you, running, idle and done with rounds and a reason chip", () => {
    const state = {
      stages: {
        spec: { status: "done" },
        backend: { status: "running", rounds: 3 },
        qa: { status: "stopped", rounds: 2 },
        review: { status: "pending" },
      },
    }
    const events = [
      { ts: "2026-11-01T09:00:00Z", type: "stage.end", stage: "backend" },
      { ts: "2026-11-01T09:10:00Z", type: "issue", stage: "qa", id: "X3", decision: { owner: "backend", blocks: true } },
      { ts: "2026-11-01T09:11:00Z", type: "progress", stage: "backend", detail: "Edit src/tip.mjs" },
      { ts: "2026-11-01T09:12:00Z", type: "stop", stage: "qa", rule: "human", detail: "copy?" },
    ]
    const cards = crewCards(crewGraph(state, events), state, events, true)
    const by = Object.fromEntries(cards.map((c) => [c.node.id, c]))
    expect(by.spec.status).toBe("done")
    expect(by.backend).toMatchObject({ status: "running", rounds: 3, line: "Edit src/tip.mjs" })
    expect(by.backend.chip).toEqual({ kind: "sendback", text: "fix X3 · qa" })
    expect(by.qa).toMatchObject({ status: "needs-you", rounds: 2 })
    expect(by.review.status).toBe("idle")
  })

  it("a non-owner stop is stopped (failed), not needs-you", () => {
    const state = { stages: { qa: { status: "stopped" } } }
    const events = [{ ts: "2026-11-01T09:12:00Z", type: "stop", stage: "qa", rule: "budget" }]
    const qa = crewCards(crewGraph(state, events), state, events, false).find((c) => c.node.id === "qa")!
    expect(qa).toMatchObject({ status: "failed", line: "stopped (budget)" })
  })

  it("does not treat a stage.end without ok as a failure, nor an old sendback as a reason", () => {
    const events = [
      { ts: "2026-11-01T09:10:00Z", type: "issue", stage: "qa", decision: { owner: "backend", blocks: true } },
      { ts: "2026-11-01T09:11:00Z", type: "stage.start", stage: "backend" },
      { ts: "2026-11-01T09:12:00Z", type: "stage.end", stage: "backend" },
    ]
    const cards = crewCards(crewGraph({ stages: {} }, events), { stages: {} }, events, false)
    const backend = cards.find((c) => c.node.id === "backend")!
    expect(backend.status).toBe("done")
    expect(backend.chip).toBeNull()
  })

  it("shows a stage the state still marks running as idle once the run is no longer live", () => {
    const state = { stages: { backend: { status: "running" } } }
    const events = [{ ts: "2026-11-01T09:00:00Z", type: "stage.start", stage: "backend" }]
    const dead = crewCards(crewGraph(state, events), state, events, false)
    expect(dead[0].status).toBe("idle")
    const live = crewCards(crewGraph(state, events), state, events, true)
    expect(live[0].status).toBe("running")
  })
})

describe("readDocs", () => {
  it("keeps only well-formed relative paths", () => {
    expect(readDocs([{ label: "contract.md", path: "spec/contract.md" }, { label: "x", path: "../etc/passwd" }, { label: "y", path: "/abs" }, { path: "z" }, null])).toEqual([{ label: "contract.md", path: "spec/contract.md" }])
    expect(readDocs("nope")).toEqual([])
  })
})
