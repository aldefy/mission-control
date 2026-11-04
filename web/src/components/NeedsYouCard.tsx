import { useState } from "react"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Textarea } from "@/components/ui/textarea"
import { parseSay } from "@/components/SayBox"
import { actionNote, postItemAction, type ActionNote as Note } from "@/lib/api"
import { ago } from "@/lib/format"
import { short } from "@/lib/events"
import { cn } from "@/lib/utils"

export type Ask = {
  /** true: an owner stop (needs you). false: stopped some other way (budget, failure rule…): grey, no buttons. */
  waiting: boolean
  lane?: string
  rule?: string
  detail?: string
  ts?: string
  /** The tool the prompt is about and its command or path (secret-safe, first 120 chars), when known. */
  tool?: string
  target?: string
  /** An agent inside the run asks (a question or permission request): answered in the run page's form, not by signing. */
  agent?: boolean
  /** The source answers this stop by signing (Ronin's contract): only then Approve / Send back. */
  sign?: boolean
}

/**
 * The right rail's top card. Waiting: what for, and the source's declared actions (sign / send back / say).
 * Stopped by any other rule: a grey "stopped" card, never "failed".
 */
export function NeedsYouCard({ source, id, ask, actions, now, onActed, flash = false }: { source: string; id: string; ask: Ask; actions: string[]; now: number; onActed?: () => void; flash?: boolean }) {
  const canSign = ask.waiting && !ask.agent && ask.sign === true && actions.includes("sign")
  const canSay = ask.waiting && !ask.agent && actions.includes("say")
  const [mode, setMode] = useState<"idle" | "back">("idle")
  const [notes, setNotes] = useState("")
  const [say, setSay] = useState("")
  const [busy, setBusy] = useState(false)
  const [note, setNote] = useState<Note | null>(null)
  const lane = ask.lane ?? ""

  const run = async (name: string, body: object, done: string, after?: () => void) => {
    setBusy(true)
    setNote(null)
    try {
      const r = await postItemAction(source, id, name, body)
      const n = actionNote(done, r)
      setNote(n)
      if (n.ok) after?.()
      onActed?.()
    } catch (e: any) {
      setNote({ ok: false, text: String(e?.message ?? e) })
    } finally {
      setBusy(false)
    }
  }

  const sendSay = () => {
    const m = parseSay(say, lane)
    if ("error" in m) return setNote({ ok: false, text: m.error })
    void run("say", m, `Sent to ${m.stage}`, () => setSay(""))
  }

  return (
    <section
      data-needs-you
      tabIndex={-1}
      aria-label={ask.waiting ? "Needs you" : "Stopped"}
      className={cn("flex flex-col gap-3 rounded-xl border p-4", ask.waiting ? "border-needs-you/70 bg-needs-you/5" : "border-stopped/40 border-dashed bg-card", flash && "mc-flash")}
    >
      <div className={cn("font-mono text-xs font-bold tracking-wider uppercase", ask.waiting ? "text-needs-you" : "text-stopped")}>
        {ask.waiting ? "Needs you" : `Stopped${ask.rule ? ` · ${ask.rule}` : ""}`}
        {lane ? <span className="font-normal normal-case"> · {lane}</span> : null}
      </div>
      <p className="text-title leading-snug font-semibold">{short(ask.detail || (ask.waiting ? `${lane || "The run"} needs you` : `${lane || "The run"} stopped`), 220)}</p>
      {(ask.tool || ask.target) && (
        <p className="flex min-w-0 items-baseline gap-1.5 text-xs">
          {ask.tool && <span data-tool className="shrink-0 font-mono font-semibold text-needs-you">{ask.tool}</span>}
          {ask.target && <code data-target title={ask.target} className="min-w-0 truncate font-mono text-muted-foreground">{ask.target}</code>}
        </p>
      )}
      <p className="font-mono text-xs text-faint">
        {ask.ts ? (ago(ask.ts, now) === "now" ? "asked just now · " : `asked ${ago(ask.ts, now)} ago · `) : ""}
        {ask.waiting ? (canSign || canSay || ask.agent ? "everything else waits until you answer" : "answer it where the agent runs") : "nothing runs until it is resumed"}
      </p>
      {ask.agent && (
        <Button variant="outline" className="justify-start" onClick={() => { const b = document.querySelector<HTMLElement>("[data-run-banner]"); b?.scrollIntoView({ block: "start", behavior: "smooth" }); b?.querySelector<HTMLElement>("input, button")?.focus({ preventScroll: true }) }}>
          Answer it at the top of the page
        </Button>
      )}
      {canSign && mode === "idle" && (
        <div className="flex flex-col gap-2">
          <Button disabled={busy} onClick={() => void run("sign", { notes: "" }, "Signed")} className="justify-start">
            Approve (sign)
          </Button>
          <Button variant="outline" disabled={busy} onClick={() => setMode("back")} className="justify-start">
            Send back with notes
          </Button>
        </div>
      )}
      {canSign && mode === "back" && (
        <div className="flex flex-col gap-2">
          <Textarea autoFocus value={notes} onChange={(e) => setNotes(e.target.value)} placeholder={`What should ${lane || "the stage"} change?`} aria-label="Send-back notes" className="font-mono text-xs" />
          <div className="flex justify-end gap-2">
            <Button variant="ghost" size="sm" onClick={() => setMode("idle")}>
              Cancel
            </Button>
            <Button size="sm" disabled={busy || !notes.trim()} onClick={() => void run("sign", { notes: notes.trim() }, "Sent back with your notes", () => { setMode("idle"); setNotes("") })}>
              Send back
            </Button>
          </div>
        </div>
      )}
      {canSay && (
        <form
          className="flex gap-2"
          onSubmit={(e) => {
            e.preventDefault()
            sendSay()
          }}
        >
          <Input value={say} onChange={(e) => setSay(e.target.value)} placeholder="or answer in your own words" aria-label="Answer" className="text-xs" disabled={busy} />
          <Button type="submit" size="sm" variant="outline" disabled={busy || !say.trim()}>
            Send
          </Button>
        </form>
      )}
      {note && (
        <p role="status" className={cn("font-mono text-xs", note.ok ? "text-running" : "text-failed")}>
          {note.text}
        </p>
      )}
    </section>
  )
}
