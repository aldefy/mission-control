import { useEffect, useRef } from "react"
import type { PaneCtx, PaneHandle, PaneTab } from "@/lib/panes"

/** Hosts one plugin pane: mounts it into a plain element, tells it about every update, unmounts it on leave. */
export function PaneMount({ pane, ctx }: { pane: PaneTab; ctx: PaneCtx }) {
  const el = useRef<HTMLDivElement>(null)
  const handle = useRef<PaneHandle>(undefined)
  const latest = useRef(ctx)
  latest.current = ctx
  useEffect(() => {
    if (!el.current) return
    try { handle.current = pane.mount(el.current, latest.current) } catch (e) { el.current.textContent = `This pane failed: ${(e as Error).message}` }
    const node = el.current
    return () => {
      try { handle.current?.unmount?.() } catch { /* the pane's own cleanup */ }
      handle.current = undefined
      node.replaceChildren()
    }
  }, [pane])
  useEffect(() => {
    try { handle.current?.update?.(ctx) } catch { /* keep the last drawing */ }
  }, [ctx])
  return <div data-pane={pane.id} ref={el} className="min-h-24" />
}
