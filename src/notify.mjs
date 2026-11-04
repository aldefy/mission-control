import { execFile } from "node:child_process"

const as = (s) => `"${String(s).replace(/[\\"]/g, "\\$&").replace(/\s+/g, " ").slice(0, 200)}"`

/**
 * A macOS notification through osascript (no click action: osascript cannot carry one); never throws.
 * Laid out like the page's: the session name, then what happened, then where.
 */
export function macNotify({ title, subtitle, message, where }, run = execFile) {
  const head = subtitle || title
  const what = subtitle ? `${title} · ${message}` : message
  const script = `display notification ${as(where || " ")} with title ${as(head)} subtitle ${as(what)}`
  run("osascript", ["-e", script], { timeout: 5000 }, () => {})
}

const HARNESS = { "claude-code": "Claude Code", codex: "Codex" }

/**
 * Every `everyMs`, notify once when an item newly needs you (`enabled("needs")`) and when one finishes its
 * prompt, working to idle while still open (`enabled("done")`). `list()` is what the dashboard shows (no
 * hidden, archived or parked items) and `overview(items)` finds what needs you in it. Deduped per session
 * (source/id). A pass with nothing enabled does no work and forgets the state, so the next enabled pass only
 * records it again: turning notifications on, or starting the dashboard, never replays old prompts.
 */
export function startNotifier({ list, overview, enabled, notify = macNotify, link = () => undefined, everyMs = 5000 }) {
  let seen = null, working = null
  let busy = false
  const key = (i) => `${i.source}/${i.id}`
  // Where a session runs, for the notification's last line: its tool, folder and branch.
  const where = (i) => [HARNESS[i.harness] ?? i.harness, String(i.cwd ?? "").split(/[\\/]/).filter(Boolean).pop(), i.branch].filter(Boolean).join(" · ")
  async function pass() {
    if (busy) return
    const needs = enabled("needs"), done = enabled("done")
    if (!needs && !done) { seen = working = null; return }
    busy = true
    try {
      const items = await list()
      const { needsYou } = await overview(items)
      const now = new Set(needsYou.map(key))
      const nowWorking = new Set(items.filter((i) => i.status === "working").map(key))
      if (seen && needs) {
        for (const n of needsYou) {
          if (!seen.has(key(n))) notify({ kind: "needs", title: "Needs you", subtitle: n.title, message: n.detail || "waiting for you", where: where(n), url: link(n), group: key(n) })
        }
      }
      if (working && done) {
        for (const i of items) {
          // Not done: closed, moved to another session id, or stopped by you (an interrupt).
          if (working.has(key(i)) && i.status === "idle" && i.open !== false && !i.parkedInto && !i.interrupted) {
            notify({ kind: "done", title: "Done", subtitle: i.title, message: "ready for your next prompt", where: where(i), url: link(i), group: key(i) })
          }
        }
      }
      seen = needs ? now : null
      working = done ? nowWorking : null
    } catch (e) {
      console.error(`${new Date().toISOString()} notifier pass failed: ${e?.stack ?? e}`) // logged, so the next pass still runs
    } finally { busy = false }
  }
  const ready = pass() // the seeding pass
  const t = setInterval(pass, everyMs)
  t.unref?.()
  return { ready, pass, stop: () => clearInterval(t) }
}

/**
 * One channel per notification, so a prompt never reaches both phone and desktop: a visible dashboard tab
 * that allowed notifications; else, for Needs you and the test, a paired phone with push on (its ping has no
 * payload and the phone shows prompts, so Done does not go there); else a background tab; else macOS (null
 * where there is none). A tab takes one only while `wants(m)`, the sidebar switch for its kind: the browser
 * permission says a tab may show it, not that the owner wants it (a paired phone alone keeps detection on). A phone ping that no push service accepted falls through to the next channel, so an expired
 * subscription does not swallow the prompt. Resolves with the channel taken, for the log and the test button.
 */
export function createDispatcher({ pages, toPages, phone = null, mac = null, wants = () => true }) {
  return async (m) => {
    const { visible, hidden } = wants(m) ? pages() : { visible: 0, hidden: 0 }
    if (visible) { toPages(true, m); return "page" }
    if (m.kind !== "done" && phone?.available()) {
      const sent = await Promise.resolve(phone.ping()).catch(() => 0)
      if (sent > 0) return "phone"
    }
    if (hidden) { toPages(false, m); return "page (background)" }
    if (mac) { mac(m); return "macOS" }
    return "none"
  }
}
