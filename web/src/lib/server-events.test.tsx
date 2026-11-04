// @vitest-environment jsdom
import { act, cleanup, render } from "@testing-library/react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { connectServerEvents, onServerChange, onServerNotify, setServerNotify } from "./server-events"
import { lastSeen, resetFreshness } from "./freshness"
import { useFetch } from "./api"

class FakeES {
  static last: FakeES | null = null
  url: string
  closed = false
  handlers = new Map<string, ((e?: { data: string }) => void)[]>()
  constructor(url: string) { this.url = url; FakeES.last = this }
  addEventListener(name: string, fn: (e?: { data: string }) => void) { this.handlers.set(name, [...(this.handlers.get(name) ?? []), fn]) }
  close() { this.closed = true }
  emit(name: string, data?: unknown) { for (const fn of this.handlers.get(name) ?? []) fn(data === undefined ? undefined : { data: JSON.stringify(data) }) }
}

beforeEach(() => resetFreshness())
afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.useRealTimers() })

describe("server events", () => {
  it("subscribes to /api/events; 'changed' tells listeners; heartbeats count as signs of life", () => {
    const stop = connectServerEvents((u) => new FakeES(u) as unknown as EventSource)
    const es = FakeES.last!
    expect(es.url).toBe("/api/events")
    const seen = vi.fn()
    const off = onServerChange(seen)
    es.emit("heartbeat")
    expect(lastSeen().ok).toBeGreaterThan(0)
    es.emit("changed")
    expect(seen).toHaveBeenCalledTimes(1)
    off()
    stop()
    expect(es.closed).toBe(true)
  })

  it("a page that wants notifications reconnects with ?notify=1 and hears 'notify' events", () => {
    const stop = connectServerEvents((u) => new FakeES(u) as unknown as EventSource)
    const first = FakeES.last!
    const heard = vi.fn()
    const off = onServerNotify(heard)
    setServerNotify(() => true)
    expect(first.closed).toBe(true)
    expect(FakeES.last!.url).toMatch(/^\/api\/events\?notify=1&visible=[01]$/)
    FakeES.last!.emit("notify", { title: "Done", subtitle: "day0paywall" })
    expect(heard).toHaveBeenCalledWith({ title: "Done", subtitle: "day0paywall" })
    setServerNotify(() => false)
    expect(FakeES.last!.url).toBe("/api/events")
    off()
    stop()
  })

  it("a polling fetch refetches at once on 'changed', without waiting for its next poll", async () => {
    vi.useFakeTimers()
    const fetch = vi.fn(async () => ({ ok: true, status: 200, json: async () => ({ n: 1 }), text: async () => JSON.stringify({ n: fetch.mock.calls.length }), headers: { get: () => null } }))
    vi.stubGlobal("fetch", fetch)
    const stop = connectServerEvents((u) => new FakeES(u) as unknown as EventSource)
    function Probe() { useFetch<{ n: number }>("/api/overview", 60_000); return null }
    render(<Probe />)
    await act(async () => { await vi.advanceTimersByTimeAsync(10) })
    expect(fetch).toHaveBeenCalledTimes(1)
    await act(async () => { FakeES.last!.emit("changed"); await vi.advanceTimersByTimeAsync(10) })
    expect(fetch).toHaveBeenCalledTimes(2)
    stop()
  })
})
