import { markOk } from "@/lib/freshness"

/**
 * Push from the server (GET /api/events, Server-Sent Events): "changed" when a hook line lands or a live
 * session file grows, "heartbeat" every 15 s. Every polling fetch listens and refetches at once on
 * "changed"; polling stays as the fallback (no EventSource, a proxy that buffers, the server restarting).
 * A page that may show notifications asks for them too (`?notify=1`) and gets "notify" events.
 */
type Listener = () => void
const listeners = new Set<Listener>()
const notifyListeners = new Set<(data: unknown) => void>()

export function onServerChange(fn: Listener): () => void {
  listeners.add(fn)
  return () => void listeners.delete(fn)
}

/** Notifications pushed to this page; they arrive only while `setServerNotify` says the page wants them. */
export function onServerNotify(fn: (data: unknown) => void): () => void {
  notifyListeners.add(fn)
  return () => void notifyListeners.delete(fn)
}

let wantsNotify: () => boolean = () => false
let reopen: (() => void) | null = null

/** Whether this page asks for notifications; reconnects the stream so the server knows at once (also after the tab is shown or hidden). */
export function setServerNotify(want: () => boolean) {
  wantsNotify = want
  reopen?.()
}

/** Open the event stream (EventSource reconnects on its own); returns a closer. Heartbeats count for freshness. */
export function connectServerEvents(make?: (url: string) => EventSource): () => void {
  let es: EventSource | null = null
  const open = () => {
    es?.close()
    es = null
    try {
      if (!make && typeof EventSource === "undefined") return // no push here: polling only
      // A page that wants notifications says so, and whether its tab is in view (the server prefers a visible one).
      const visible = typeof document !== "undefined" && document.visibilityState === "visible" ? "1" : "0"
      es = (make ?? ((u: string) => new EventSource(u)))(wantsNotify() ? `/api/events?notify=1&visible=${visible}` : "/api/events")
    } catch {
      return
    }
    es.addEventListener("heartbeat", () => markOk())
    es.addEventListener("changed", () => {
      markOk()
      for (const fn of [...listeners]) fn()
    })
    es.addEventListener("notify", (e) => {
      let data: unknown
      try { data = JSON.parse((e as MessageEvent).data) } catch { return }
      for (const fn of [...notifyListeners]) fn(data)
    })
  }
  open()
  reopen = open
  return () => {
    reopen = null
    es?.close()
  }
}
