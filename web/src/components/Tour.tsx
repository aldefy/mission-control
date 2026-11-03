import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react"
import { createPortal } from "react-dom"
import { CircleHelp, X } from "lucide-react"
import { useItems, type ItemSummary } from "@/lib/api"
import { toHash } from "@/lib/route"
import { markTourDone, pickTourItem, placeNote, tourDone, tourSteps, type Box, type TourStep } from "@/lib/tour"
import { cn } from "@/lib/utils"

const PAD = 6 // spotlight margin around the element
const NOTE_W = 340
// Strong enough to read as "dimmed" on the dark themes too, where the page is already near black.
const DIM = "rgb(0 0 0 / 0.72)"

/** The element a step points at, when it is on screen with a size (a closed sidebar has none). */
function findAnchor(anchor: string | undefined): Box | null {
  if (!anchor) return null
  const el = document.querySelector<HTMLElement>(`[data-tour="${anchor}"]`)
  if (!el) return null
  const r = el.getBoundingClientRect()
  if (r.width < 2 || r.height < 2) return null
  return { top: r.top - PAD, left: r.left - PAD, width: r.width + PAD * 2, height: r.height + PAD * 2 }
}

const same = (a: Box | null, b: Box | null) =>
  a === b || (!!a && !!b && Math.abs(a.top - b.top) < 1 && Math.abs(a.left - b.left) < 1 && Math.abs(a.width - b.width) < 1 && Math.abs(a.height - b.height) < 1)

/** Opens the step's page: Home, or the tour's item on the step's tab. */
function goTo(step: TourStep, item: ItemSummary | null) {
  if (!step.go) return
  const hash = step.go.view === "home" ? toHash({ view: "home" }) : item ? toHash({ view: "item", source: item.source, id: item.id, tab: step.go.tab }) : null
  if (hash && location.hash !== hash && !(hash === "#/" && (location.hash === "" || location.hash === "#"))) location.hash = hash
}

/** The tour itself: a dimmed page with a spotlight on one element and a note beside it. */
export function TourOverlay({ items, loading = false, onClose }: { items: ItemSummary[] | null; loading?: boolean; onClose: () => void }) {
  // The session is chosen once, when the tour starts, so the steps never change under you mid-tour.
  const [locked, setLocked] = useState<ItemSummary | null | undefined>(undefined)
  const picked = useMemo(() => pickTourItem(items), [items])
  const item = locked !== undefined ? locked : picked
  const steps = useMemo(() => tourSteps(item), [item])
  const [i, setI] = useState(0)
  const waiting = i === 0 && loading && !items
  const step = steps[Math.min(i, steps.length - 1)]
  const [box, setBox] = useState<Box | null>(null)
  const noteRef = useRef<HTMLDivElement>(null)
  const [noteH, setNoteH] = useState(180)
  const [view, setView] = useState({ w: window.innerWidth, h: window.innerHeight })

  const close = useCallback(() => {
    markTourDone()
    onClose()
  }, [onClose])
  const next = useCallback(() => {
    if (waiting) return
    if (i === 0 && locked === undefined) setLocked(picked)
    if (i >= steps.length - 1) close()
    else setI(i + 1)
  }, [i, steps.length, close, waiting, locked, picked])
  const back = useCallback(() => setI((n) => Math.max(0, n - 1)), [])

  useEffect(() => goTo(step, item), [step, item])

  // Follow the element: pages load and move under the tour, so look again until it settles and on scroll/resize.
  useEffect(() => {
    setBox(null)
    let last: Box | null = null
    const look = () => {
      const b = findAnchor(step.anchor)
      if (!same(b, last)) {
        last = b
        setBox(b)
      }
      if (b) document.querySelector(`[data-tour="${step.anchor}"]`)?.scrollIntoView?.({ block: "nearest", inline: "nearest" })
    }
    look()
    const t = setInterval(look, 250)
    const onResize = () => {
      setView({ w: window.innerWidth, h: window.innerHeight })
      look()
    }
    window.addEventListener("resize", onResize)
    window.addEventListener("scroll", look, true)
    return () => {
      clearInterval(t)
      window.removeEventListener("resize", onResize)
      window.removeEventListener("scroll", look, true)
    }
  }, [step])

  useLayoutEffect(() => {
    const h = noteRef.current?.offsetHeight
    if (h && Math.abs(h - noteH) > 1) setNoteH(h)
  })
  useEffect(() => noteRef.current?.focus(), [i])

  useEffect(() => {
    const on = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault()
        e.stopPropagation()
        close()
      } else if (e.key === "ArrowRight") {
        e.preventDefault()
        next()
      } else if (e.key === "ArrowLeft") {
        e.preventDefault()
        back()
      }
    }
    window.addEventListener("keydown", on, true)
    return () => window.removeEventListener("keydown", on, true)
  }, [close, next, back])

  const width = Math.min(NOTE_W, view.w - 24)
  const at = placeNote(box, { width, height: noteH }, view.w, view.h)

  return createPortal(
    <div data-tour-overlay className="fixed inset-0 z-[70]">
      {/* The dim with a hole: one box whose huge shadow covers the rest of the page. It also takes clicks. */}
      <div
        aria-hidden
        data-tour-spotlight={box ? "on" : "off"}
        className="absolute rounded-lg transition-all duration-200 motion-reduce:transition-none"
        style={
          box
            ? {
                top: box.top,
                left: box.left,
                width: box.width,
                height: box.height,
                // An outline, not a ring: Tailwind rings are box-shadows, and this box-shadow is the dim.
                outline: "2px solid var(--brand)",
                outlineOffset: 2,
                boxShadow: `0 0 0 6px color-mix(in oklab, var(--brand) 18%, transparent), 0 0 0 9999px ${DIM}`,
              }
            : { inset: 0, background: DIM }
        }
      />
      <div
        ref={noteRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="mc-tour-title"
        aria-describedby="mc-tour-body"
        tabIndex={-1}
        data-tour-step={step.id}
        className="absolute flex flex-col gap-3 rounded-xl border border-brand/40 bg-popover p-4 text-popover-foreground shadow-2xl"
        // The note takes focus for the keys; the page's focus outline on it would read as a second highlight.
        style={{ top: at.top, left: at.left, width, outline: "none" }}
      >
        <div className="flex items-start gap-2">
          <h2 id="mc-tour-title" className="flex-1 text-sm font-semibold">
            {step.title}
          </h2>
          <button type="button" onClick={close} aria-label="End tour" className="grid size-6 shrink-0 place-items-center rounded text-muted-foreground hover:bg-accent hover:text-foreground">
            <X className="size-3.5" />
          </button>
        </div>
        <p id="mc-tour-body" className="text-sm leading-relaxed text-muted-foreground">
          {step.body}
        </p>
        <div className="flex items-center gap-2">
          <span className="flex-1 font-mono text-xs text-faint tabular-nums">
            {i + 1} / {steps.length}
          </span>
          {i > 0 && (
            <button type="button" onClick={back} className="h-7 rounded-md border px-2.5 text-xs text-muted-foreground hover:border-ring hover:text-foreground">
              Back
            </button>
          )}
          <button type="button" onClick={next} disabled={waiting} className="h-7 rounded-md bg-brand px-3 text-xs font-medium text-brand-foreground hover:brightness-110 disabled:opacity-60">
            {i >= steps.length - 1 ? "Done" : i === 0 ? (waiting ? "Loading…" : "Start") : "Next"}
          </button>
        </div>
      </div>
    </div>,
    document.body,
  )
}

/** The top-bar button that starts the tour; a small dot marks it until the tour has been seen once. */
export function TourButton() {
  const [open, setOpen] = useState(false)
  const [seen, setSeen] = useState(() => tourDone())
  // Recent items only: the tour needs one session, not the whole history.
  const items = useItems({ limit: 200 }, open, false)
  return (
    <>
      <button
        type="button"
        data-tour="tour"
        onClick={() => setOpen(true)}
        aria-label="Take the tour"
        title="Take the tour"
        className="relative grid size-8 shrink-0 place-items-center rounded-md text-muted-foreground hover:bg-accent hover:text-foreground"
      >
        <CircleHelp className="size-4" />
        {!seen && <span aria-hidden data-tour-new className="absolute top-1.5 right-1.5 size-1.5 rounded-full bg-brand" />}
      </button>
      {open && (
        <TourOverlay
          items={items.data}
          loading={items.loading}
          onClose={() => {
            setOpen(false)
            setSeen(true)
          }}
        />
      )}
    </>
  )
}
