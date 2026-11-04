import { useEffect } from "react"
import { onServerNotify, setServerNotify } from "@/lib/server-events"

const supported = () => typeof window !== "undefined" && "Notification" in window

export const notifyPermission = (): NotificationPermission | "unsupported" => (supported() ? Notification.permission : "unsupported")

const granted = () => notifyPermission() === "granted"

/** Ask the browser for notification permission (needs a click); once granted, the event stream asks for them. */
export async function askNotifyPermission() {
  if (!supported()) return "unsupported"
  const p = await Notification.requestPermission()
  setServerNotify(granted)
  return p
}

type Payload = { title: string; subtitle?: string; message?: string; where?: string; url?: string; group?: string; dismissAfter?: number }

/** Tell the server what happened to a notification, for its log (~/.mission-control/logs/notifications.log). */
function ack(m: { group?: string } | null, result: string) {
  fetch("/api/events/ack", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ group: m?.group ?? "", result, permission: notifyPermission(), visible: document.visibilityState }),
  }).catch(() => {})
}

function show(m: Payload) {
  if (!granted()) return ack(m, "not shown: permission " + notifyPermission())
  try {
    // The tag keeps one notification per session; renotify alerts again when it replaces one (a tag alone
    // replaces silently), and requireInteraction keeps it on screen until clicked or dismissed (otherwise a
    // macOS banner slides away at once).
    // Title: the session's name. Body: what happened, then where (the browser adds the site below).
    const n = new Notification(m.subtitle || m.title, {
      body: [m.subtitle ? `${m.title} · ${m.message ?? ""}` : (m.message ?? ""), m.where].filter(Boolean).join("\n"),
      tag: m.group, renotify: !!m.group, requireInteraction: true,
    } as NotificationOptions)
    if (m.dismissAfter && m.dismissAfter > 0) setTimeout(() => n.close(), m.dismissAfter * 1000)
    n.onshow = () => ack(m, "shown")
    n.onerror = () => ack(m, "error")
    n.onclick = () => {
      window.focus()
      if (m.url) location.hash = m.url
      n.close()
    }
  } catch (err) {
    ack(m, `failed: ${(err as Error)?.message ?? err}`)
  }
}

/**
 * While notifications are allowed, the page's event stream asks for them and each one is shown; a click
 * brings this tab forward on that session. Otherwise the page does not ask, so the server falls back to macOS.
 */
export function useNeedsYouNotifications() {
  useEffect(() => {
    setServerNotify(granted)
    // Reconnect when the tab is shown or hidden, so the server knows which page is in view.
    const onVisibility = () => { if (granted()) setServerNotify(granted) }
    document.addEventListener("visibilitychange", onVisibility)
    const off = onServerNotify((d) => {
      show(d as Payload) // never throws: a failure is reported back instead
    })
    return () => {
      off()
      document.removeEventListener("visibilitychange", onVisibility)
      setServerNotify(() => false)
    }
  }, [])
}
