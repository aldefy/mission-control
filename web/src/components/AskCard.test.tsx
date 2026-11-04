// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react"
import { afterEach, describe, expect, it, vi } from "vitest"
import { AskCard } from "./AskCard"

afterEach(cleanup)

describe("AskCard", () => {
  it("answers a two-field question: one pick, several picks plus a typed answer", async () => {
    const act = vi.fn(async () => ({}))
    const ask = { kind: "asking" as const, stage: "research", id: "f1", question: true as const, title: "Questions", fields: [
      { key: "q0", title: "Focus", type: "string", options: [{ value: "Redesign", label: "Redesign scope" }, { value: "SDUI" }] },
      { key: "q1", title: "Sources", type: "multiselect", custom: true, options: [{ value: "Repo only" }, { value: "Docs" }] },
    ] }
    render(<AskCard ask={ask} act={act} canReply canApprove />)
    const send = screen.getByRole("button", { name: "Send answer" })
    expect((send as HTMLButtonElement).disabled).toBe(true)
    fireEvent.click(screen.getByLabelText(/Redesign scope/))
    fireEvent.click(screen.getByLabelText(/Repo only/))
    fireEvent.click(screen.getByLabelText(/Docs/))
    fireEvent.change(screen.getByLabelText("Sources: your own answer"), { target: { value: "Reddit" } })
    fireEvent.click(send)
    await waitFor(() => expect(screen.getByText(/Sent\./)).toBeTruthy())
    expect(act).toHaveBeenCalledWith("reply", { id: "f1", answer: { q0: "Redesign", q1: ["Repo only", "Docs", "Reddit"] } })
  })
  it("answers a permission request", async () => {
    const act = vi.fn(async () => ({}))
    render(<AskCard ask={{ kind: "asking", stage: "qa", id: "p1", question: false, action: "bash", resources: ["ls"], message: null }} act={act} canReply canApprove />)
    fireEvent.click(screen.getByRole("button", { name: "Allow once" }))
    await waitFor(() => expect(act).toHaveBeenCalledWith("approve", { id: "p1", decision: "once" }))
  })
})
