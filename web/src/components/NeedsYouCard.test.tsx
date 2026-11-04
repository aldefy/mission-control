// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react"
import { afterEach, describe, expect, it, vi } from "vitest"
import { NeedsYouCard } from "./NeedsYouCard"

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

const NOW = Date.parse("2026-01-01T10:10:00Z")

describe("NeedsYouCard", () => {
  it("a signable owner stop says Needs you and offers the declared actions", () => {
    render(<NeedsYouCard source="ronin" id="r1" now={NOW} ask={{ waiting: true, lane: "architect", rule: "human", detail: "Sign the contract", sign: true }} actions={["sign", "say"]} />)
    expect(screen.getByLabelText("Needs you")).toBeTruthy()
    expect(screen.getByRole("button", { name: "Approve (sign)" })).toBeTruthy()
    expect(screen.getByRole("button", { name: "Send back with notes" })).toBeTruthy()
    expect(screen.getByLabelText("Answer")).toBeTruthy()
  })

  it("an owner question that is not a sign-off offers no Approve, only an answer", () => {
    render(<NeedsYouCard source="ronin" id="r1" now={NOW} ask={{ waiting: true, lane: "product", rule: "human", detail: "Which feature should this run build first?" }} actions={["sign", "say"]} />)
    expect(screen.getByLabelText("Needs you")).toBeTruthy()
    expect(screen.queryByRole("button", { name: "Approve (sign)" })).toBeNull()
    expect(screen.queryByRole("button", { name: "Send back with notes" })).toBeNull()
    expect(screen.getByLabelText("Answer")).toBeTruthy()
  })

  it("any other stop is a grey Stopped card with no buttons", () => {
    render(<NeedsYouCard source="ronin" id="r1" now={NOW} ask={{ waiting: false, lane: "frontend", rule: "budget", detail: "over budget" }} actions={["sign", "say"]} />)
    const c = screen.getByLabelText("Stopped")
    expect(c.textContent).toContain("Stopped · budget")
    expect(c.className).toContain("border-stopped")
    expect(c.className).not.toContain("failed")
    expect(screen.queryAllByRole("button")).toHaveLength(0)
    expect(screen.queryByRole("textbox")).toBeNull()
  })

  it("a source without actions shows the question only", () => {
    render(<NeedsYouCard source="claude-code" id="s1" now={NOW} ask={{ waiting: true, lane: "main", detail: "Claude needs your permission" }} actions={[]} />)
    expect(screen.getByText("Claude needs your permission")).toBeTruthy()
    expect(screen.queryAllByRole("button")).toHaveLength(0)
  })

  it("sign posts to the item action route; resumed:false shows the error (v1 fix)", async () => {
    const fetch = vi.fn(async () => ({ ok: true, status: 200, json: async () => ({ ok: true, resumed: false, error: "spawn ronin ENOENT" }) }))
    vi.stubGlobal("fetch", fetch)
    const onActed = vi.fn()
    render(<NeedsYouCard source="ronin" id="r1" now={NOW} ask={{ waiting: true, lane: "architect", rule: "human", sign: true }} actions={["sign"]} onActed={onActed} />)
    fireEvent.click(screen.getByRole("button", { name: "Approve (sign)" }))
    await waitFor(() => expect(screen.getByRole("status").textContent).toBe("Signed, but the run could not resume: spawn ronin ENOENT"))
    expect(screen.getByRole("status").className).toContain("text-failed")
    expect(fetch).toHaveBeenCalledWith("/api/item/ronin/r1/action/sign", expect.objectContaining({ method: "POST", body: JSON.stringify({ notes: "" }) }))
    expect(onActed).toHaveBeenCalled()
  })
})
