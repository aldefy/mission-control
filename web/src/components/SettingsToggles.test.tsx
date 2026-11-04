// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react"
import { afterEach, describe, expect, it, vi } from "vitest"
import { SettingsToggles } from "./SettingsToggles"

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

const settings = (extra = {}) => ({ notify: false, notifyDone: false, notifyDismiss: 10, autostart: { supported: false, enabled: false }, retention: { configDir: "/u/.claude", days: 30, isDefault: true }, ...extra })

function stubFetch(body: object) {
  const posts: unknown[] = []
  vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
    if (init?.method === "POST") posts.push(JSON.parse(String(init.body)))
    return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } })
  }))
  return posts
}

describe("SettingsToggles", () => {
  it("Keep sessions writes Claude Code's settings.json only after a confirm that names the file", async () => {
    const posts = stubFetch(settings())
    render(<SettingsToggles />)
    fireEvent.click(await screen.findByRole("button", { name: "90" }))
    expect(screen.getByRole("group", { name: "Confirm Keep sessions" }).textContent).toContain("/u/.claude/settings.json")
    expect(posts).toEqual([])
    fireEvent.click(screen.getByRole("button", { name: "cancel" }))
    expect(screen.queryByRole("group", { name: "Confirm Keep sessions" })).toBeNull()
    fireEvent.click(screen.getByRole("button", { name: "90" }))
    fireEvent.click(screen.getByRole("button", { name: "apply" }))
    await waitFor(() => expect(posts).toEqual([{ retentionDays: 90 }]))
  })

  it("an npx copy says start at login needs an installed copy instead of offering the switch", async () => {
    stubFetch(settings({ autostart: { supported: false, enabled: false, reason: "start at login needs an installed copy (npm i -g @aldefy/mission-control), not npx" } }))
    render(<SettingsToggles />)
    expect(await screen.findByText("needs npm i -g")).toBeTruthy()
    expect(screen.queryByRole("switch", { name: /Start at login/ })).toBeNull()
  })
})
