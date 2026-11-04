import { useEffect, useState } from "react"
import type { ItemDetail } from "@/lib/api"
import { postItemAction } from "@/lib/api"

/**
 * Pane plugins: an adapter ships its own UI as one ES module (adapter `ui`, served at /ui/<source>/page.js).
 * Its default export is called once with the host and registers what it adds; today, item tabs:
 *
 *   export default function (host) {
 *     host.tabs.register({ id: "report", label: "Report", mount(el, ctx) { ...; return { update(ctx) {}, unmount() {} } } })
 *   }
 *
 * `mount` gets a plain element and the item (summary, lanes, events, state), and is told again on every
 * update (`update`), so a pane stays live with the page. It draws with the DOM, no React needed; the theme's
 * CSS variables (var(--foreground), var(--muted-foreground), var(--border), …) style it like the rest.
 */
export type PaneCtx = {
  source: string
  id: string
  item: ItemDetail
  /** Call one of the adapter's actions (POST /api/item/:source/:id/action/:name). */
  action: (name: string, body?: object) => Promise<unknown>
  /** URL of one of the adapter's extras for this item (GET /api/item/:source/:id/x/:name?…). */
  extra: (name: string, params?: Record<string, string>) => string
}
export type PaneHandle = { update?: (ctx: PaneCtx) => void; unmount?: () => void } | void
export type PaneTab = { id: string; label: string; kinds?: string[]; mount: (el: HTMLElement, ctx: PaneCtx) => PaneHandle }

const SAFE = /^[a-z][\w-]{0,31}$/
const cache = new Map<string, Promise<PaneTab[]>>()

/** Load a pane module once per page and collect what it registers. A module that fails adds nothing. */
export function loadPanes(url: string, load: (u: string) => Promise<any> = (u) => import(/* @vite-ignore */ u)): Promise<PaneTab[]> {
  let p = cache.get(url)
  if (!p) {
    p = load(url).then((m) => {
      const tabs: PaneTab[] = []
      const host = {
        tabs: {
          register(t: PaneTab) {
            if (t && SAFE.test(t.id) && typeof t.label === "string" && typeof t.mount === "function" && !tabs.some((x) => x.id === t.id)) tabs.push({ ...t, label: t.label.slice(0, 24) })
          },
        },
      }
      m?.default?.(host)
      return tabs
    }).catch((e) => {
      console.warn(`pane module ${url} failed to load:`, e)
      return []
    })
    cache.set(url, p)
  }
  return p
}

export function usePanes(url: string | null | undefined, kind: string | undefined): PaneTab[] {
  const [tabs, setTabs] = useState<PaneTab[]>([])
  useEffect(() => {
    let alive = true
    if (!url) { setTabs([]); return }
    loadPanes(url).then((t) => alive && setTabs(t))
    return () => { alive = false }
  }, [url])
  return tabs.filter((t) => !t.kinds || (kind !== undefined && t.kinds.includes(kind)))
}

export const paneTabKey = (id: string) => `pane-${id}`

export function paneCtx(source: string, id: string, item: ItemDetail): PaneCtx {
  const base = `/api/item/${encodeURIComponent(source)}/${encodeURIComponent(id)}`
  return {
    source, id, item,
    action: (name, body = {}) => postItemAction(source, id, name, body),
    extra: (name, params = {}) => `${base}/x/${encodeURIComponent(name)}${Object.keys(params).length ? `?${new URLSearchParams(params)}` : ""}`,
  }
}
