// Runs before every page and frame of the recording. The UI is the real app; this only supplies data where the
// demo cannot: the phone page's /api/remote/* (real pairing needs a Tailscale host and HTTPS), and the sidebar
// settings as a normal install shows them (the demo's stand-in home hides Start at login and would show a
// scratch path). Settings POSTs never reach the server.
(() => {
  const realFetch = window.fetch.bind(window)
  const J = (b, status = 200) => Promise.resolve(new Response(JSON.stringify(b), { status, headers: { "content-type": "application/json" } }))
  const path = (u) => { try { return new URL(typeof u === "string" ? u : u.url, location.href).pathname } catch { return "" } }

  if (location.pathname === "/remote.html") {
    const ago = (m) => new Date(Date.now() - m * 60000).toISOString()
    let list = [
      { source: "claude-code", id: "sess-api-waiting", title: "Rotate staging keys", project: "api", lane: "main", tool: "Bash",
        target: "./scripts/rotate-keys.sh staging", since: ago(39), answerable: true, promptId: "p1", bind: "b1", kind: "permission" },
      { source: "claude-code", id: "sess-search-ui", title: "Search bar with suggestions", project: "shop-search", lane: "main", tool: "AskUserQuestion",
        target: "", since: ago(2), answerable: true, promptId: "p2", bind: "b2", kind: "ask",
        questions: [{ question: "Show recent searches when the box is empty?", header: "Empty state", multiSelect: false,
          options: [{ label: "Last 5 searches", description: "Shown under the box until you type" }, { label: "Nothing", description: "Keep the empty box clean" }] }] },
    ]
    const listeners = new Set()
    window.fetch = (u, o = {}) => {
      const p = path(u)
      if (p === "/api/remote/me") return J({ device: { id: "d1", label: "iPhone" } })
      if (p === "/api/remote/prompts") return J({ prompts: list })
      if (p === "/api/remote/answer") {
        const b = JSON.parse(o.body || "{}")
        list = list.filter((e) => e.promptId !== b.promptId)
        setTimeout(() => listeners.forEach((f) => f("changed")), 450)
        return new Promise((r) => setTimeout(() => r(J({ ok: true })), 380))
      }
      return realFetch(u, o)
    }
    class FakeEventSource {
      constructor() {
        this.h = {}
        this.fire = (n) => (this.h[n] || []).forEach((f) => f({ type: n }))
        listeners.add(this.fire)
        setTimeout(() => this.fire("open"), 30)
        this.iv = setInterval(() => this.fire("heartbeat"), 1500)
      }
      addEventListener(n, f) { (this.h[n] = this.h[n] || []).push(f) }
      close() { clearInterval(this.iv); listeners.delete(this.fire) }
    }
    window.EventSource = FakeEventSource
    return
  }

  const s = {
    notify: false, notifyDone: false, notifyDismiss: 10,
    autostart: { supported: true, reason: null, enabled: false, managed: false, label: "dev.mission-control.4319" },
    retention: { configDir: "~/.claude", days: 30, isDefault: true },
  }
  window.fetch = (u, o = {}) => {
    const p = path(u)
    if (p === "/api/settings") {
      if ((o.method || "GET").toUpperCase() === "POST") {
        const b = JSON.parse(o.body || "{}")
        if ("autostart" in b) s.autostart = { ...s.autostart, enabled: b.autostart }
        if ("retentionDays" in b) s.retention = { ...s.retention, days: b.retentionDays, isDefault: b.retentionDays === 30 }
        for (const k of ["notify", "notifyDone", "notifyDismiss"]) if (k in b) s[k] = b[k]
        return J({ ...s, restarting: false })
      }
      return J(s)
    }
    if (p === "/api/settings/test") return J({ via: "page" })
    return realFetch(u, o)
  }
})()
