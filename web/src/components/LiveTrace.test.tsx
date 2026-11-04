// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react"
import { afterEach, describe, expect, it, vi } from "vitest"
import type { Call } from "@/lib/api"
import { LiveTrace } from "./LiveTrace"

afterEach(cleanup)
const call = (id: string, lane: string, over: Partial<Call> = {}): Call => ({ id, lane, ts: "2026-11-04T08:00:00Z", name: "Bash", kind: "tool", summary: `cmd ${id}`, ok: true, durationMs: 1200, ...over })

describe("LiveTrace", () => {
  it("groups calls into lane runs, marks failures and the running call, opens a call on click", () => {
    const onOpen = vi.fn()
    render(<LiveTrace calls={[call("a", "main"), call("b", "sub1", { ok: false, error: "exit 1" }), call("c", "main", { ok: undefined, durationMs: undefined })]} live laneLabel={(l) => (l === "main" ? "main" : "explorer")} onOpen={onOpen} />)
    expect(screen.getAllByText("main")).toHaveLength(2)
    expect(screen.getByText("explorer")).toBeTruthy()
    expect(screen.getByText(/1 failed/)).toBeTruthy()
    expect(screen.getByText("running")).toBeTruthy()
    expect(screen.getByText("1.2s")).toBeTruthy()
    fireEvent.click(screen.getByText("cmd b"))
    expect(onOpen).toHaveBeenCalledWith("b")
  })
  it("says so when there are no calls", () => {
    render(<LiveTrace calls={[]} live={false} laneLabel={(l) => l} onOpen={() => {}} />)
    expect(screen.getByText("No tool calls yet.")).toBeTruthy()
  })
})
