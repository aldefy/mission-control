// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react"
import { afterEach, describe, expect, it, vi } from "vitest"
import { Steer } from "./Steer"

afterEach(() => { cleanup(); vi.unstubAllGlobals() })

describe("Steer", () => {
  it("queues a message, shows it waiting, and can cancel it", async () => {
    let queued: { id: string; text: string; from: string; at: string }[] = []
    const calls: [string, string | undefined][] = []
    vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
      calls.push([url, init?.body as string | undefined])
      if (url.endsWith("/steer") && init?.method === "POST") queued = [{ id: "m1", text: JSON.parse(init.body as string).text, from: "dashboard", at: "" }]
      if (url.endsWith("/steer/cancel")) queued = []
      return new Response(JSON.stringify({ queued }), { status: 200 })
    }))
    render(<Steer source="claude-code" id="s1" working />)
    expect(screen.getByText("Delivered when the current turn ends.")).toBeTruthy()
    fireEvent.change(screen.getByRole("textbox"), { target: { value: "also run the tests" } })
    fireEvent.click(screen.getByRole("button", { name: "Queue message" }))
    await waitFor(() => expect(screen.getByText("also run the tests")).toBeTruthy())
    expect(calls.some(([u, b]) => u === "/api/item/claude-code/s1/steer" && b === JSON.stringify({ text: "also run the tests" }))).toBe(true)
    fireEvent.click(screen.getByRole("button", { name: "Cancel this message" }))
    await waitFor(() => expect(screen.queryByText("also run the tests")).toBeNull())
  })
})
