import { useEffect, useState } from "react"
import { Send, X } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Textarea } from "@/components/ui/textarea"
import { cancelSteer, getSteer, postSteer, type Steer as SteerMsg } from "@/lib/api"
import { cn } from "@/lib/utils"

/**
 * Steer a running session: the message waits until the agent's current turn ends, then its Stop hook hands it
 * over as the next prompt, so the agent carries on with it. An idle session has no turn to end: type in its
 * terminal instead.
 */
export function Steer({ source, id, working, className }: { source: string; id: string; working: boolean; className?: string }) {
  const [text, setText] = useState("")
  const [queued, setQueued] = useState<SteerMsg[]>([])
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    let alive = true
    const load = () => getSteer(source, id).then((q) => alive && setQueued(q)).catch(() => {})
    load()
    // Delivered messages leave the queue when the turn ends.
    const t = setInterval(load, 3000)
    return () => { alive = false; clearInterval(t) }
  }, [source, id])

  const send = async () => {
    if (!text.trim() || busy) return
    setBusy(true)
    setError(null)
    try {
      setQueued(await postSteer(source, id, text))
      setText("")
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setBusy(false)
    }
  }

  return (
    <section data-steer className={cn("flex flex-col gap-2 rounded-lg border border-border p-3", className)}>
      <div className="flex items-baseline justify-between gap-2">
        <h3 className="text-sm font-medium">Steer this session</h3>
        <span className="text-xs text-faint">
          {working ? "Delivered when the current turn ends." : "Idle: it is delivered when the next turn ends. To start one now, type in its terminal."}
        </span>
      </div>
      {queued.length > 0 && (
        <ul className="flex flex-col gap-1" aria-label="Waiting to be delivered">
          {queued.map((m) => (
            <li key={m.id} className="flex items-start gap-2 rounded border border-border bg-muted/40 px-2 py-1 text-xs">
              <span className="flex-1 whitespace-pre-wrap">{m.text}</span>
              <span className="text-faint">waiting</span>
              <button type="button" aria-label="Cancel this message" className="text-faint hover:text-foreground"
                onClick={async () => setQueued(await cancelSteer(source, id, m.id).catch(() => queued))}>
                <X className="size-3.5" />
              </button>
            </li>
          ))}
        </ul>
      )}
      <div className="flex items-end gap-2">
        <Textarea value={text} onChange={(e) => setText(e.target.value)} rows={2} maxLength={4000}
          placeholder="Tell the agent what to do next, e.g. also cover the empty state, then run the tests"
          onKeyDown={(e) => { if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) { e.preventDefault(); send() } }} />
        <Button type="button" onClick={send} disabled={busy || !text.trim()} aria-label="Queue message">
          <Send className="size-4" /> Send
        </Button>
      </div>
      {error && <p role="alert" className="text-xs text-destructive">{error}</p>}
    </section>
  )
}
