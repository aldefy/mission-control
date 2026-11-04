import { useEffect, useState, type ReactNode } from "react"
import { Bell, BellOff, History, Info, Power, Timer } from "lucide-react"
import { postSettings, postTestNotification, useSettings, type Settings } from "@/lib/api"
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

const DEFAULT_DAYS = 30 // Claude Code's own default for cleanupPeriodDays
const PRESETS = [DEFAULT_DAYS, 60, 90]

/** Keep sessions: type any number of days (Enter or leaving the box saves), or pick a preset. */
function RetentionRow({ retention, busy, onSet }: { retention: NonNullable<Settings["retention"]>; busy: boolean; onSet: (days: number) => void }) {
  const [draft, setDraft] = useState<string | null>(null)
  // This writes Claude Code's own settings.json, so a new value waits for a confirm that names the file.
  const [pending, setPending] = useState<number | null>(null)
  const value = draft ?? String(pending ?? retention.days ?? "")
  const save = () => {
    const n = Number(value)
    setDraft(null)
    if (Number.isInteger(n) && n >= 1 && n <= 3650 && n !== retention.days) setPending(n)
  }
  const title = `How long Claude Code keeps session history (cleanupPeriodDays in ${retention.configDir}/settings.json, default 30). Older sessions are deleted when Claude Code starts. Applies from its next start.`
  if (retention.error) {
    return (
      <div className={line} title={retention.error}>
        <History />
        <span className="flex-1">Keep sessions</span>
        <span className="text-failed">settings.json invalid</span>
      </div>
    )
  }
  return (
    <div className="flex flex-col gap-1" title={title}>
      <div className={line}>
        <History />
        <span className="flex-1">Keep sessions</span>
        <input
          type="number"
          aria-label="Keep sessions for, in days"
          min={1}
          max={3650}
          disabled={busy}
          value={value}
          onChange={(e) => setDraft(e.target.value)}
          onBlur={save}
          onKeyDown={(e) => {
            if (e.key === "Enter") e.currentTarget.blur()
            if (e.key === "Escape") setDraft(null)
          }}
          className="h-5 w-12 rounded border border-sidebar-border bg-transparent px-1 text-right text-foreground outline-none [appearance:textfield] focus-visible:border-ring [&::-webkit-inner-spin-button]:appearance-none"
        />
        <span>days</span>
      </div>
      <div className="flex items-center gap-1 pl-[18px]">
        {PRESETS.map((d) => (
          <button
            key={d}
            type="button"
            disabled={busy}
            aria-pressed={retention.days === d}
            onClick={() => { setDraft(null); setPending(d !== retention.days ? d : null) }}
            className={cn("rounded border border-sidebar-border px-1.5 leading-5 hover:text-muted-foreground", retention.days === d && "border-foreground/40 text-foreground")}
          >
            {d === DEFAULT_DAYS ? `${d} (default)` : d}
          </button>
        ))}
      </div>
      {pending !== null && (
        <div role="group" aria-label="Confirm Keep sessions" className="flex flex-col gap-1 pl-[18px] text-[11px] leading-snug">
          <span>
            Sets cleanupPeriodDays to {pending} in <span className="break-all text-foreground">{retention.configDir}/settings.json</span>
            {pending < (retention.days ?? DEFAULT_DAYS) ? ". Claude Code deletes older sessions at its next start." : ". Sessions already deleted don't come back."}
          </span>
          <span className="flex gap-2">
            <button type="button" disabled={busy} className="text-foreground underline underline-offset-2 hover:text-muted-foreground" onClick={() => { onSet(pending); setPending(null) }}>
              apply
            </button>
            <button type="button" className="underline-offset-2 hover:underline" onClick={() => setPending(null)}>cancel</button>
          </span>
        </div>
      )}
    </div>
  )
}

/** Waits for the dashboard to answer again (launchd's copy taking over the port), then reloads the page. */
async function reloadWhenBack() {
  for (let i = 0; i < 60; i++) {
    await new Promise((r) => setTimeout(r, 1000))
    try { if ((await fetch("/api/sources")).ok) return location.reload() } catch { /* still restarting */ }
  }
}

/** Sidebar settings: notifications (needs you, done), the browser permission and a test, session retention, start at login. */
/**
 * Sidebar settings: Notifications (Needs you and Done, off until you turn them on; dismiss time; the browser
 * permission and a test), History (how long Claude Code keeps sessions) and Startup (start at login).
 */
export function SettingsToggles() {
  const s = useSettings()
  const [note, setNote] = useState<string | null>(null)
  // A note clears itself after 10 s, except while the dashboard restarts (the page reloads when it is back).
  useEffect(() => {
    if (!note || note.startsWith("restarting")) return
    const t = setTimeout(() => setNote(null), 10_000)
    return () => clearTimeout(t)
  }, [note])
  const [busy, setBusy] = useState(false)
  const [permission, setPermission] = useState(notifyPermission)
  if (typeof s.data?.notify !== "boolean") return null // not loaded, or a server without settings
  const { notify } = s.data
  const notifyDone = s.data.notifyDone ?? false
  const dismiss = s.data.notifyDismiss ?? 10
  const autostart = s.data.autostart ?? { supported: false, enabled: false }
  const retention = s.data.retention ?? null
  const change = async (patch: { notify?: boolean; notifyDone?: boolean; notifyDismiss?: number; autostart?: boolean; retentionDays?: number }) => {
    setBusy(true)
    setNote(null)
    try {
      const r = await postSettings(patch)
      if (r.restarting) {
        setNote("restarting under launchd…")
        await reloadWhenBack()
        return
      }
      if (patch.autostart === false) setNote("won't start at next login")
      s.reload()
    } catch (e) {
      setNote(String((e as Error).message ?? e))
    } finally {
      setBusy(false)
    }
  }
  const any = notify || notifyDone
  const toggle = (on: boolean, label: string, title: string, patch: () => void, icon = on ? <Bell /> : <BellOff />) => (
    <button type="button" role="switch" aria-checked={on} disabled={busy} className={row} onClick={patch} title={title}>
      {icon}
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
      {retention && (
        <Section title="History">
          <RetentionRow retention={retention} busy={busy} onSet={(days) => change({ retentionDays: days })} />
        </Section>
      )}
      {autostart.supported ? (
        <Section title="Startup">
          {toggle(autostart.enabled, "Start at login", `Start this dashboard at login and again if it fails (LaunchAgent ${autostart.label ?? ""})`,
            () => change({ autostart: !autostart.enabled }), <Power />)}
        </Section>
      ) : autostart.reason && !autostart.reason.includes("macOS") ? (
        <Section title="Startup">
          <div className={line} title={autostart.reason}>
            <Power />
            <span className="flex-1">Start at login</span>
            <span>needs npm i -g</span>
          </div>
        </Section>
      ) : null}
      {note && <span className="px-1 text-[11px] leading-snug">{note}</span>}
    </div>
  )
}
