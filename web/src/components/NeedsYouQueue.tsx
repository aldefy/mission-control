import { useEffect, useRef, useState, type ReactNode } from "react"
import { postItemAction, type ItemSummary, type NeedsYou } from "@/lib/api"
import { ago } from "@/lib/format"
import { toHash } from "@/lib/route"
import { cn } from "@/lib/utils"
import { STATUS_LABEL } from "@/components/StatusDot"

const itemHref = (source: string, id: string) => toHash({ view: "item", source, id, tab: "lanes" })

/** How long a replaced (or newly arrived) prompt keeps its "new prompt" badge. */
export const NEW_PROMPT_MS = 8000
export type PromptTrack = { seen: Map<string, string>; fresh: Map<string, number> }
const promptKey = (e: NeedsYou) => `${e.source}/${e.id}`
// The prompt's own ask time only: updatedAt moves with every log line and would flag the same prompt as new.
const promptStamp = (e: NeedsYou) => `${e.since ?? ""}|${e.lane}`

/**
 * Which prompts are new: an item whose waiting prompt changed (a different since) or that started waiting
 * since the last answer. `fresh` maps item key -> when its badge expires. The first load (prev null)
 * flags nothing: what was already waiting when the page opened is not news.
 */
export function trackPrompts(prev: PromptTrack | null, entries: NeedsYou[], at: number): PromptTrack {
  const seen = new Map(entries.map((e) => [promptKey(e), promptStamp(e)]))
  const fresh = new Map<string, number>()
  if (prev) {
    for (const [k, until] of prev.fresh) if (until > at && seen.has(k)) fresh.set(k, until)
    for (const [k, stamp] of seen) if (prev.seen.get(k) !== stamp) fresh.set(k, at + NEW_PROMPT_MS)
  }
  return { seen, fresh }
}

/** The keys of prompts that are new right now; badges drop when they expire. */
function useNewPrompts(entries: NeedsYou[], loaded: boolean): Set<string> {
  const track = useRef<PromptTrack | null>(null)
  const [fresh, setFresh] = useState<Map<string, number>>(new Map())
  const sig = entries.map((e) => `${promptKey(e)}=${promptStamp(e)}`).join(",")
  useEffect(() => {
    if (!loaded) return // the empty list while the first answer loads is not "nothing was waiting"
    track.current = trackPrompts(track.current, entries, Date.now())
    setFresh(track.current.fresh)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sig, loaded])
  useEffect(() => {
    if (!fresh.size) return
    const next = Math.min(...fresh.values())
    const t = setTimeout(() => {
      const at = Date.now()
      const kept = new Map([...fresh].filter(([, until]) => until > at))
      if (track.current) track.current = { ...track.current, fresh: kept }
      setFresh(kept)
    }, Math.max(0, next - Date.now()))
    return () => clearTimeout(t)
  }, [fresh])
  return new Set(fresh.keys())
}

const asked = (since: string | null | undefined, now: number) => {
  const a = ago(since, now)
  return a === "–" ? null : a === "now" ? "asked just now" : `asked ${a} ago`
}
const BTN = "inline-flex h-7 items-center rounded-md px-2.5 text-xs whitespace-nowrap transition-colors disabled:opacity-50"

function Ask({ e, actions, now, onActed, isNew = false }: { e: NeedsYou; actions: string[]; now: number; onActed?: () => void; isNew?: boolean }) {
  const [busy, setBusy] = useState(false)
  const [note, setNote] = useState<{ ok: boolean; text: string } | null>(null)
  const canSign = e.sign === true && actions.includes("sign")
  const canSay = actions.includes("say")
  const href = itemHref(e.source, e.id)
  const sign = async () => {
    setBusy(true)
    setNote(null)
    try {
      await postItemAction(e.source, e.id, "sign", { notes: "" })
      setNote({ ok: true, text: "Signed." })
      onActed?.()
    } catch (err: any) {
      setNote({ ok: false, text: String(err?.message ?? err) })
    } finally {
      setBusy(false)
    }
  }
  return (
    <article data-new-prompt={isNew || undefined} className={cn("relative rounded-xl border border-needs-you/40 bg-card p-3 hover:border-needs-you/70", isNew && "mc-flash border-needs-you/80")}>
      <div className="flex items-baseline justify-between gap-2 text-xs text-faint">
        <span className="truncate">{[e.project?.name, e.lane].filter(Boolean).join(" · ")}</span>
        {isNew ? (
          <span className="shrink-0 rounded-full bg-needs-you/15 px-1.5 font-mono text-needs-you">new prompt</span>
        ) : (
          <span className="shrink-0 font-mono">{ago(e.updatedAt, now)}</span>
        )}
      </div>
      {/* The title is the card's link; its ::after covers the card, so the whole card opens the item. */}
      <a href={href} className="mt-0.5 line-clamp-2 block text-sm after:absolute after:inset-0 after:rounded-xl after:content-[''] hover:underline">
        {e.title || e.id}
      </a>
      {(e.tool || e.target) && (
        <p className="mt-1 flex min-w-0 items-baseline gap-1.5 text-xs">
          {e.tool && <span data-tool className="shrink-0 font-mono font-semibold text-needs-you">{e.tool}</span>}
          {e.target && <code data-target title={e.target} className="min-w-0 truncate font-mono text-muted-foreground">{e.target}</code>}
        </p>
      )}
      {e.detail && !(e.tool && /permission to use/i.test(e.detail)) && <p className="mt-1 line-clamp-3 text-xs text-muted-foreground">{e.detail}</p>}
      {asked(e.since, now) && <p className="mt-1 font-mono text-xs text-faint">{asked(e.since, now)}</p>}
      {canSign || canSay ? (
        <div className="relative z-[1] mt-2 flex flex-wrap gap-2">
          {canSign && (
            <button type="button" disabled={busy} onClick={() => void sign()} className={cn(BTN, "bg-primary text-primary-foreground hover:bg-primary/85")}>
              Sign
            </button>
          )}
          <a href={href} className={cn(BTN, "border border-input hover:bg-accent")}>
            Answer…
          </a>
        </div>
      ) : (
        <div className="relative z-[1] mt-2 flex items-center justify-between gap-2">
          <span className="text-xs text-muted-foreground">answer in terminal</span>
          <a href={href} className="inline-flex h-7 items-center rounded-md border border-input px-2.5 text-xs hover:bg-accent">
            Open
          </a>
        </div>
      )}
      {note && (
        <p role="status" className={cn("mt-1.5 font-mono text-xs", note.ok ? "text-running" : "text-failed")}>
          {note.text}
        </p>
      )}
    </article>
  )
}

/**
 * The needs-you queue (directions.html B, left rail): one card per item waiting on you, with answer
 * buttons when its source declares actions and an "answer in terminal" hint when it does not; then
 * what stopped recently.
 */
export function NeedsYouQueue({
  entries,
  stopped,
  actions,
  onActed,
  now = Date.now(),
  loaded = true,
  between,
}: {
  entries: NeedsYou[]
  stopped: ItemSummary[]
  /** Source name -> the actions it declares (from /api/sources). */
  actions: Record<string, string[]>
  onActed?: () => void
  now?: number
  /** False while the first answer is loading: prompts already waiting then are not flagged "new". */
  loaded?: boolean
  /** Shown after the cards, before Stopped (Home puts Looping and Ready here). */
  between?: ReactNode
}) {
  const fresh = useNewPrompts(entries, loaded)
  return (
    <div className="flex flex-col gap-3">
      <h2 className="text-base font-semibold">
        Needs you <span className={cn("text-sm", entries.length ? "text-needs-you" : "text-faint")}>{entries.length}</span>
      </h2>
      {!entries.length && (
        <div className="rounded-xl border border-dashed p-3">
          <p className="text-sm text-muted-foreground">Nothing needs you</p>
          <p className="mt-0.5 text-xs text-faint">Questions and permission prompts from any session show up here.</p>
        </div>
      )}
      {entries.map((e) => (
        <Ask key={`${e.source}/${e.id}`} e={e} actions={actions[e.source] ?? []} now={now} onActed={onActed} isNew={fresh.has(promptKey(e))} />
      ))}
      {between}
      {stopped.length > 0 && (
        <>
          <h3 className="pt-2 text-xs text-faint">Stopped</h3>
          {stopped.map((i) => (
            <article key={`${i.source}/${i.id}`} className="rounded-xl border bg-card p-3">
              <div className="flex items-baseline justify-between gap-2 text-xs text-faint">
                <span className="truncate">{[i.project?.name, i.branch].filter(Boolean).join(" · ")}</span>
                <span className={cn("shrink-0 font-mono", i.status === "failed" && "text-failed")}>
                  {STATUS_LABEL[i.status]} · {ago(i.updatedAt, now)}
                </span>
              </div>
              <a href={itemHref(i.source, i.id)} className="mt-0.5 line-clamp-2 block text-sm hover:underline">
                {i.title || i.id}
              </a>
            </article>
          ))}
        </>
      )}
    </div>
  )
}
