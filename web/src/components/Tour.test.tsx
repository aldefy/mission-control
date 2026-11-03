// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import type { ItemSummary } from "@/lib/api"
import { TOUR_DONE_KEY } from "@/lib/tour"
import { TourOverlay } from "./Tour"

const session = {
  source: "claude-code", id: "s1", kind: "session", title: "Fix login", harness: "claude-code", cwd: "/w/app", branch: "main",
  live: true, status: "working", waiting: false, startedAt: null, updatedAt: "2026-11-03T00:00:00Z", counts: { lanes: 2, calls: 99, errors: 0 },
} as ItemSummary

const step = () => document.querySelector("[data-tour-step]")?.getAttribute("data-tour-step")

beforeEach(() => {
  localStorage.clear()
  location.hash = "#/usage"
})
afterEach(cleanup)

describe("TourOverlay", () => {
  it("walks the steps, opening Home and then the picked session on the right tab", () => {
    render(<TourOverlay items={[session]} onClose={() => {}} />)
    expect(step()).toBe("welcome")
    expect(screen.getByRole("dialog").textContent).toContain('"Fix login"')
    fireEvent.click(screen.getByText("Start"))
    expect(step()).toBe("chips")
    expect(location.hash).toBe("#/")
    for (let i = 0; i < 4; i++) fireEvent.click(screen.getByText("Next"))
    expect(step()).toBe("status")
    expect(location.hash).toBe("#/item/claude-code/s1/lanes")
    fireEvent.keyDown(window, { key: "ArrowRight" })
    fireEvent.keyDown(window, { key: "ArrowRight" })
    expect(step()).toBe("map")
    expect(location.hash).toBe("#/item/claude-code/s1/map")
    fireEvent.keyDown(window, { key: "ArrowLeft" })
    expect(step()).toBe("lanes")
  })

  it("keeps the session it started with when the list changes mid-tour", () => {
    const { rerender } = render(<TourOverlay items={[session]} onClose={() => {}} />)
    fireEvent.click(screen.getByText("Start"))
    rerender(<TourOverlay items={[{ ...session, id: "other", title: "Other" }]} onClose={() => {}} />)
    for (let i = 0; i < 4; i++) fireEvent.click(screen.getByText("Next"))
    expect(screen.getByRole("dialog").textContent).toContain('"Fix login"')
  })

  it("waits for the session list before starting", () => {
    render(<TourOverlay items={null} loading onClose={() => {}} />)
    const b = screen.getByText("Loading…")
    expect(b).toHaveProperty("disabled", true)
    fireEvent.click(b)
    expect(step()).toBe("welcome")
  })

  it("Esc ends it and remembers it was seen", () => {
    const onClose = vi.fn()
    render(<TourOverlay items={[session]} onClose={onClose} />)
    act(() => {
      fireEvent.keyDown(window, { key: "Escape" })
    })
    expect(onClose).toHaveBeenCalledOnce()
    expect(localStorage.getItem(TOUR_DONE_KEY)).toBe("done")
  })

  it("Done on the last step closes it", () => {
    const onClose = vi.fn()
    render(<TourOverlay items={[]} onClose={onClose} />)
    fireEvent.click(screen.getByText("Start"))
    while (!screen.queryByText("Done")) fireEvent.click(screen.getByText("Next"))
    expect(step()).toBe("end")
    fireEvent.click(screen.getByText("Done"))
    expect(onClose).toHaveBeenCalledOnce()
  })
})
