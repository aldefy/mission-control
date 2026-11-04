import { useEffect, useMemo, useState, type ReactNode } from "react"
import { PanelLeft, Search } from "lucide-react"
import { useItems, useSources, type ItemSummary, type ProjectSummary } from "@/lib/api"
import { useShared } from "@/lib/projects-context"
import { toHash, type Route } from "@/lib/route"
import { doneToday, worktreeLabel, type ChipFilter } from "@/lib/tree"
import { cn } from "@/lib/utils"
import { workingLine } from "@/lib/status-ui"
import { BP, useMedia } from "@/lib/media"
import { useNeedsYouNotifications } from "@/lib/notify"
import { FreshnessBadge } from "@/components/Freshness"
import { ThemePicker } from "@/components/ThemePicker"
import { useTheme } from "@/lib/use-theme"
import { CommandPalette, isPaletteKey } from "@/components/CommandPalette"
import { Sidebar } from "@/components/Sidebar"
import { chipCounts, StatusChips } from "@/components/StatusChips"
import { BudgetChip } from "@/components/Budgets"
import { RemoteChip } from "@/components/RemoteChip"
import { useBudgets } from "@/lib/api-v22"
import { browserTz } from "@/lib/api"

const SIDEBAR_KEY = "mission-control-sidebar"

function stored(key: string): string | null {
  try {
    return localStorage.getItem(key)
  } catch {
    return null
  }
}
function store(key: string, v: string) {
  try {
    localStorage.setItem(key, v)
  } catch {}
}

const LISTS = new Set<Route["view"]>(["home", "project", "worktree"])

/** The footer note: the page writes nothing unless a source declares actions. */
export const footerNote = (actions: string[] | undefined) =>
  `${actions?.length ? "read-only except your actions" : "read-only"} · local · 127.0.0.1`

/** Breadcrumbs for a route, with names looked up in the project tree (`item`: the item route's summary, placed). */
export function crumbs(route: Route, projects: ProjectSummary[], item?: ItemSummary | null): { label: string; href?: string }[] {
  const home = { label: "home", href: toHash({ view: "home" }) }
  const project = (key: string) => projects.find((p) => p.key === key)
  switch (route.view) {
    case "home":
      return [{ label: "home" }]
    case "usage":
      return [home, { label: "usage" }]
    case "remote":
      return [home, { label: "remote" }]
    case "project":
      return [home, { label: project(route.key)?.name ?? route.key }]
    case "worktree": {
      const p = project(route.key)
      const w = p?.worktrees.find((x) => x.path === route.path)
      return [home, { label: p?.name ?? route.key, href: toHash({ view: "project", key: route.key }) }, { label: w ? worktreeLabel(w) : route.path }]
    }
    case "item": {
      const at = item?.project
      if (item && at) {
        const w = project(at.key)?.worktrees.find((x) => x.path === at.worktree)
        return [
          home,
          { label: at.name, href: toHash({ view: "project", key: at.key }) },
          { label: w ? worktreeLabel(w) : item.branch || worktreeLabel({ path: at.worktree, branch: null }), href: toHash({ view: "worktree", key: at.key, path: at.worktree }) },
          { label: item.title || item.id },
        ]
      }
      return [home, { label: `${route.source} · ${route.id}` }]
    }
    case "run":
      return [home, { label: route.id }]
    case "agent":
      return [home, { label: route.id, href: toHash({ view: "run", id: route.id, tab: "map" }) }, { label: route.stage }]
    case "repo":
      return [home, { label: route.repo }]
  }
}

function Crumbs({ items }: { items: { label: string; href?: string }[] }) {
  return (
    <nav aria-label="Breadcrumb" className="flex h-9 min-w-0 shrink-0 items-center gap-2 overflow-hidden border-b px-5 font-mono text-xs whitespace-nowrap text-muted-foreground">
      {items.map((c, i) => (
        <span key={i} className={cn("flex min-w-0 items-center gap-2", i === items.length - 1 ? "shrink" : "shrink-[3]")}>
          {i > 0 && <span className="text-faint">/</span>}
          {c.href && i < items.length - 1 ? (
            <a href={c.href} className="inline-flex min-h-6 min-w-0 items-center truncate hover:text-foreground">
              {c.label}
            </a>
          ) : (
            <span className="max-w-[420px] min-w-0 truncate text-foreground">{c.label}</span>
          )}
        </span>
      ))}
    </nav>
  )
}

export function Shell({ route, children }: { route: Route; children: ReactNode }) {
  const theme = useTheme()
  const [sidebar, setSidebar] = useState(() => stored(SIDEBAR_KEY) !== "closed")
  const [palette, setPalette] = useState(false)
  const { projects, visible: tree, hiddenCount, showHidden, setShowHidden, overview, filter, setFilter, resetView } = useShared()
  const sources = useSources()
  const budgets = useBudgets(browserTz())
  // The item route's summary, placed in its project: for the crumbs and the sidebar selection.
  const isItem = route.view === "item"
  const found = useItems(isItem ? { all: true, source: route.source, id: route.id } : {}, isItem, false)
  const item = isItem ? (found.data?.[0] ?? null) : null

  // Only Home and project pages list items; from anywhere else a chip opens Home with that filter.
  const pickChip = (f: ChipFilter | null) => {
    setFilter(f)
    if (f && !LISTS.has(route.view)) location.hash = toHash({ view: "home" })
  }
  useNeedsYouNotifications()
  useEffect(() => store(SIDEBAR_KEY, sidebar ? "open" : "closed"), [sidebar])
  // Below lg the sidebar is an overlay drawer, closed by default and on every navigation.
  const desktop = useMedia(BP.lg)
  const [drawer, setDrawer] = useState(false)
  const open = desktop ? sidebar : drawer
  const routeKey = JSON.stringify(route)
  useEffect(() => setDrawer(false), [routeKey, desktop])
  useEffect(() => {
    if (!drawer) return
    const on = (e: KeyboardEvent) => e.key === "Escape" && setDrawer(false)
    window.addEventListener("keydown", on)
    return () => window.removeEventListener("keydown", on)
  }, [drawer])
  useEffect(() => {
    const on = (e: KeyboardEvent) => {
      if (isPaletteKey(e)) {
        e.preventDefault()
        setPalette((o) => !o)
      }
    }
    window.addEventListener("keydown", on)
    return () => window.removeEventListener("keydown", on)
  }, [])

  const counts = useMemo(() => chipCounts(overview.data, doneToday(tree)), [overview.data, tree])
  const actions = sources.data?.flatMap((s) => s.actions)

  return (
    <div className="flex h-screen flex-col overflow-hidden bg-background text-foreground">
      <a href="#main" onClick={(e) => { e.preventDefault(); document.getElementById("main")?.focus() }} className="sr-only z-50 rounded-md bg-background px-3 py-2 text-sm focus:not-sr-only focus:fixed focus:top-2 focus:left-2">
        Skip to content
      </a>
      <header className="flex h-12 shrink-0 items-center gap-2 border-b px-3">
        <button
          type="button"
          onClick={() => (desktop ? setSidebar((s) => !s) : setDrawer((s) => !s))}
          aria-label={open ? "Hide sidebar" : "Show sidebar"}
          aria-pressed={open}
          aria-controls="mc-sidebar"
          className="grid size-8 shrink-0 place-items-center rounded-md text-muted-foreground hover:bg-accent hover:text-foreground"
        >
          <PanelLeft className="size-4" />
        </button>
        <a href="#/" onClick={resetView} aria-label="mission control, home" className="mr-1 flex h-8 shrink-0 items-center gap-2 text-sm font-semibold tracking-tight whitespace-nowrap lg:mr-3">
          <span className="grid size-4 place-items-center rounded-full border-[1.5px] border-brand">
            <span className="size-1.5 rounded-full bg-brand" />
          </span>
          <span className="hidden sm:inline">mission control</span>
        </a>
        <StatusChips counts={counts} active={filter} onPick={pickChip} />
        <div className="ml-auto flex shrink-0 items-center gap-2">
          <RemoteChip />
          <BudgetChip budgets={budgets.data?.budgets} />
          <FreshnessBadge />
          <span data-working-line className="hidden items-center gap-1.5 border-l pl-2 font-mono text-xs whitespace-nowrap text-faint xl:flex">
            {workingLine(overview.data?.live ?? [])}
          </span>
          <button
            type="button"
            onClick={() => setPalette(true)}
            aria-label="Search (⌘K)"
            className="flex h-8 w-8 items-center justify-center gap-2 rounded-md border bg-surface/60 text-xs text-muted-foreground hover:border-ring hover:text-foreground lg:w-56 lg:justify-start lg:px-2.5"
          >
            <Search className="size-3.5 shrink-0" />
            <span className="hidden flex-1 text-left lg:inline">Search…</span>
            <kbd className="hidden rounded border px-1 font-mono text-xs lg:inline">⌘K</kbd>
          </button>
          <ThemePicker theme={theme} />
        </div>
      </header>
      <div className="flex min-h-0 flex-1">
        {!desktop && drawer && <button type="button" aria-label="Close sidebar" tabIndex={-1} onClick={() => setDrawer(false)} className="fixed inset-0 top-12 z-30 bg-background/60 backdrop-blur-[1px]" />}
        <div
          id="mc-sidebar"
          inert={!open}
          className={cn(
            "min-h-0 overflow-hidden transition-[width] duration-150 motion-reduce:transition-none",
            desktop ? (open ? "w-[264px]" : "w-0") : cn("fixed top-12 bottom-0 left-0 z-40 border-r bg-sidebar shadow-xl", open ? "w-[280px]" : "w-0 border-r-0"),
          )}
        >
          <Sidebar
            projects={tree}
            loading={projects.loading}
            error={projects.error}
            route={route}
            itemWhere={item?.project ?? null}
            filter={filter}
            footer={footerNote(actions)}
            hiddenCount={hiddenCount}
            showHidden={showHidden}
            onShowHidden={setShowHidden}
          />
        </div>
        <div className="flex min-w-0 flex-1 flex-col">
          <Crumbs items={crumbs(route, projects.data ?? [], item)} />
          <main id="main" tabIndex={-1} className="min-h-0 flex-1 overflow-y-auto p-5 outline-none">{children}</main>
        </div>
      </div>
      <CommandPalette open={palette} onOpenChange={setPalette} projects={tree} showHidden={showHidden} />
    </div>
  )
}
