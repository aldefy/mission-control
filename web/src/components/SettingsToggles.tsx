import { useEffect, useState, type ReactNode } from "react"
import { Bell, BellOff, Info, Timer } from "lucide-react"
import { postSettings, postTestNotification, useSettings } from "@/lib/api"
import { InfoTip } from "@/components/IconAction"
import { askNotifyPermission, notifyPermission } from "@/lib/notify"
import { cn } from "@/lib/utils"

const BROWSER_INFO =
  "Browser notifications: a visible dashboard tab shows them, and clicking one opens that session here. Otherwise a paired phone with push on gets Needs you, then a background tab, then macOS (no click action). One channel per notification, never two."
// Every row: icon, label, value on the right. `row` is the clickable variant.
const line = "flex h-6 w-full items-center gap-1.5 rounded px-1 [&_svg]:size-3 [&_svg]:shrink-0"
const row = `${line} text-left hover:bg-sidebar-accent/60 hover:text-muted-foreground disabled:opacity-50`

function Section({ title, action, children }: { title: string; action?: ReactNode; children: ReactNode }) {
  return (
    <section className="flex flex-col gap-0.5">
      <div className="flex items-center justify-between px-1 pb-0.5 text-[11px] tracking-wide uppercase">
        <span>{title}</span>
        {action}
      </div>
      {children}
    </section>
  )
}

/** Sidebar Notifications: Needs you and Done (off until you turn them on), dismiss time, the browser permission and a test. */
export function SettingsToggles() {
  const s = useSettings()
  const [note, setNote] = useState<string | null>(null)
  // A note clears itself after 10 s.
  useEffect(() => {
    if (!note) return
    const t = setTimeout(() => setNote(null), 10_000)
    return () => clearTimeout(t)
  }, [note])
  const [busy, setBusy] = useState(false)
  const [permission, setPermission] = useState(notifyPermission)
  if (typeof s.data?.notify !== "boolean") return null // not loaded, or a server without settings
  const { notify } = s.data
  const notifyDone = s.data.notifyDone ?? false
  const dismiss = s.data.notifyDismiss ?? 10
  const change = async (patch: { notify?: boolean; notifyDone?: boolean; notifyDismiss?: number }) => {
    setBusy(true)
    setNote(null)
    try {
      await postSettings(patch)
      s.reload()
    } catch (e) {
      setNote(String((e as Error).message ?? e))
    } finally {
      setBusy(false)
    }
  }
  const any = notify || notifyDone
  const toggle = (on: boolean, label: string, title: string, patch: () => void) => (
    <button type="button" role="switch" aria-checked={on} disabled={busy} className={row} onClick={patch} title={title}>
      {on ? <Bell /> : <BellOff />}
      <span className="flex-1">{label}</span>
      <span className={cn(on && "text-foreground")}>{on ? "on" : "off"}</span>
    </button>
  )
  const sendTest = async () => {
    try {
      const { via } = await postTestNotification()
      setNote(
        via.startsWith("page") ? "test sent to this page: none showing? Allow your browser in macOS System Settings → Notifications, and check Focus"
        : via.startsWith("phone") ? "test sent to your paired phone (this tab is not visible or has not allowed notifications)"
        : via === "macOS" ? "test sent as a macOS notification (no tab or phone to take it)"
        : "nowhere to send it: allow browser notifications here, or pair a phone",
      )
    } catch (e) { setNote(String((e as Error).message ?? e)) }
  }
  const browser =
    permission === "granted" ? <span className="text-foreground">allowed</span>
    : permission === "denied" ? <span title="Blocked in the browser's site settings: macOS notifications show instead, without a click action">blocked</span>
    : permission === "unsupported" ? <span>n/a</span>
    : <button type="button" className="text-foreground underline underline-offset-2 hover:text-muted-foreground" onClick={async () => setPermission(await askNotifyPermission())}>allow</button>
  return (
    <div className="flex flex-col gap-2.5 border-t border-sidebar-border px-2 py-2 font-mono text-xs text-faint">
      <Section
        title="Notifications"
        action={any && <button type="button" disabled={busy} onClick={sendTest} className="normal-case tracking-normal underline-offset-2 hover:text-muted-foreground hover:underline">send test</button>}
      >
        {toggle(notify, "Needs you", "When a session needs you: a permission prompt or a question", () => change({ notify: !notify }))}
        {toggle(notifyDone, "Done", "When a session finishes your prompt and is ready for the next one", () => change({ notifyDone: !notifyDone }))}
        <label className={line} title="How long a browser notification stays on screen before it closes itself">
          <Timer />
          <span className="flex-1">Dismiss after</span>
          <select
            aria-label="Dismiss notifications after"
            disabled={busy}
            value={String(dismiss)}
            onChange={(e) => change({ notifyDismiss: Number(e.target.value) })}
            className="rounded bg-transparent text-right text-foreground outline-none"
          >
            {[...new Set([5, 10, 30, 60, 0, dismiss])].map((d) => (
              <option key={d} value={d}>{d === 0 ? "stay" : d < 60 ? `${d}s` : `${d / 60} min`}</option>
            ))}
          </select>
        </label>
        <div className={line}>
          <Bell />
          <span className="flex-1">Browser</span>
          {browser}
          <InfoTip text={BROWSER_INFO}>
            <Info />
          </InfoTip>
        </div>
      </Section>
      {note && <span className="px-1 text-[11px] leading-snug">{note}</span>}
    </div>
  )
}
