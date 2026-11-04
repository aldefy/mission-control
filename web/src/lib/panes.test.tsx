// @vitest-environment jsdom
import { cleanup, render } from "@testing-library/react"
import { afterEach, describe, expect, it, vi } from "vitest"
import { loadPanes, paneCtx, type PaneTab } from "./panes"
import { PaneMount } from "@/components/PaneMount"

afterEach(cleanup)
const item = { summary: { id: "r1" }, lanes: [], events: [{ type: "report" }] } as any

describe("pane plugins", () => {
  it("collects valid tabs once per module and ignores bad ones; a failing module adds nothing", async () => {
    const mod = { default: (host: any) => {
      host.tabs.register({ id: "reports", label: "Reports", mount() {} })
      host.tabs.register({ id: "reports", label: "Again", mount() {} })
      host.tabs.register({ id: "Bad Id", label: "x", mount() {} })
      host.tabs.register({ id: "nolabel", mount() {} })
    } }
    const load = vi.fn(async () => mod)
    expect((await loadPanes("/ui/a/page.js", load)).map((t) => t.id)).toEqual(["reports"])
    await loadPanes("/ui/a/page.js", load)
    expect(load).toHaveBeenCalledTimes(1)
    vi.spyOn(console, "warn").mockImplementation(() => {})
    expect(await loadPanes("/ui/b/page.js", async () => { throw new Error("syntax") })).toEqual([])
  })
  it("mounts a pane, tells it about updates, unmounts it", () => {
    const seen: string[] = []
    const pane: PaneTab = { id: "p", label: "P", mount(el, ctx) {
      el.textContent = `events ${ctx.item.events.length}`
      return { update: (c) => { el.textContent = `events ${c.item.events.length}`; seen.push("update") }, unmount: () => seen.push("unmount") }
    } }
    const { container, rerender, unmount } = render(<PaneMount pane={pane} ctx={paneCtx("ronin", "r1", item)} />)
    expect(container.textContent).toBe("events 1")
    rerender(<PaneMount pane={pane} ctx={paneCtx("ronin", "r1", { ...item, events: [1, 2] })} />)
    expect(container.textContent).toBe("events 2")
    unmount()
    expect(seen).toContain("unmount")
    expect(paneCtx("ronin", "r 1", item).extra("raw", { path: "a b" })).toBe("/api/item/ronin/r%201/x/raw?path=a+b")
  })
})
