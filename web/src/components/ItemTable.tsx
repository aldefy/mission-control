import { useMemo, useState } from "react"
import { Archive, ArchiveRestore, ArrowDown, ArrowUp, Pencil, Pin, PinOff } from "lucide-react"
import { postMark, type ItemSummary, type Status } from "@/lib/api"
import { ago, compact, money } from "@/lib/format"
import { toHash } from "@/lib/route"
import { worktreeLabel } from "@/lib/tree"
import { cn } from "@/lib/utils"
import { RenameForm } from "@/components/RenameForm"
import { CopyResume } from "@/components/CopyResume"
import { IconAction } from "@/components/IconAction"
import { STATUS_LABEL, STATUS_TEXT, StatusDot } from "@/components/StatusDot"

export type SortKey = "title" | "where" | "harness" | "status" | "lanes" | "calls" | "cost" | "sinceChange" | "updated"
export type SortDir = "asc" | "desc"

const URGENCY: Status[] = ["waiting", "looping", "working", "failed", "stopped", "done", "idle"]
const where = (i: ItemSummary) => `${i.project?.name ?? ""} ${i.branch ?? ""}`.trim().toLowerCase()
const time = (i: ItemSummary) => String(i.updatedAt ?? "")

const KEYS: Record<SortKey, (i: ItemSummary) => string | number> = {
  title: (i) => (i.title || i.id).toLowerCase(),
  where,
  harness: (i) => i.harness,
  status: (i) => URGENCY.indexOf(i.status) + (i.open === false ? URGENCY.length : 0),
  lanes: (i) => i.counts.lanes,
  calls: (i) => i.counts.calls,
  cost: (i) => i.cost ?? 0,
  // Unknown (not opened yet) sorts below every known value in both directions' "most first" view.
  sinceChange: (i) => i.sinceChange?.tokens ?? -1,
  updated: time,
}

/** Items ordered by a column, pinned ones first; ties fall back to newest first. Does not mutate. */
export function sortItems(items: ItemSummary[], key: SortKey, dir: SortDir): ItemSummary[] {
  const get = KEYS[key]
  const sign = dir === "asc" ? 1 : -1
  return [...items].sort((a, b) => {
    if (!!a.pinned !== !!b.pinned) return a.pinned ? -1 : 1
    const x = get(a), y = get(b)
    const c = typeof x === "number" && typeof y === "number" ? x - y : String(x).localeCompare(String(y))
    return c * sign || time(b).localeCompare(time(a))
  })
}

const HOVER = "relative z-10 opacity-0 group-hover:opacity-100 focus-visible:opacity-100"

type Col = { key: SortKey; label: string; first: SortDir; className?: string; num?: boolean }

/**
 * Runs and sessions as a dense, sortable table: title, project/branch, harness, status, lanes, calls,
 * cost, updated. Newest first; a header click sorts by that column, a second click flips it.
 */
export function ItemTable({
  items,
  showProject = true,
  empty = "Nothing here yet",
  cap = 100,
  now = Date.now(),
  onChanged,
}: {
  items: ItemSummary[]
  /** Project name before the branch (Home); a project page shows the branch alone. */
  showProject?: boolean
  empty?: string
  /** Rows shown before a "Show all" button. */
  cap?: number
  now?: number
  /** Called after a row is renamed, pinned or archived, to reload the list. */
  onChanged?: () => void
}) {
  const [editing, setEditing] = useState<string | null>(null)
  const mark = (i: ItemSummary, patch: { pinned?: boolean; archived?: boolean }) =>
    postMark(i.source, i.id, patch).then(() => onChanged?.(), () => {})
  const [sort, setSort] = useState<{ key: SortKey; dir: SortDir }>({ key: "updated", dir: "desc" })
  const [all, setAll] = useState(false)
  const rows = useMemo(() => sortItems(items, sort.key, sort.dir), [items, sort])
  const shown = all ? rows : rows.slice(0, cap)

  const cols: Col[] = [
    { key: "title", label: "Title", first: "asc" },
    { key: "where", label: showProject ? "Project / branch" : "Branch", first: "asc", className: "w-[22%]" },
    { key: "harness", label: "Harness", first: "asc", className: "w-[92px]" },
    { key: "status", label: "Status", first: "asc", className: "w-[90px]" },
    { key: "lanes", label: "Lanes", first: "desc", num: true, className: "w-[54px]" },
    { key: "calls", label: "Calls", first: "desc", num: true, className: "w-[68px]" },
    { key: "cost", label: "Cost", first: "desc", num: true, className: "w-[60px]" },
    { key: "sinceChange", label: "Since change", first: "desc", num: true, className: "w-[96px]" },
    { key: "updated", label: "Updated", first: "desc", num: true, className: "w-[72px]" },
  ]
  const pick = (c: Col) =>
    setSort((s) => (s.key === c.key ? { key: c.key, dir: s.dir === "asc" ? "desc" : "asc" } : { key: c.key, dir: c.first }))

  if (!items.length) return <p className="px-1 py-6 text-center text-xs text-faint">{empty}</p>
  return (
    <div className="overflow-x-auto">
      <table className="w-full table-fixed border-collapse text-xs">
        <thead>
          <tr className="border-b text-left">
            {cols.map((c) => {
              const on = sort.key === c.key
              return (
                <th
                  key={c.key}
                  aria-sort={on ? (sort.dir === "asc" ? "ascending" : "descending") : "none"}
                  className={cn("h-8 px-2 font-normal whitespace-nowrap text-faint", c.num && "text-right", c.className)}
                >
                  <button
                    type="button"
                    onClick={() => pick(c)}
                    className={cn("inline-flex min-h-6 items-center gap-1 py-1 hover:text-foreground", on && "text-muted-foreground")}
                  >
                    {c.label}
                    {on && (sort.dir === "asc" ? <ArrowUp aria-hidden className="size-3" /> : <ArrowDown aria-hidden className="size-3" />)}
                  </button>
                </th>
              )
            })}
          </tr>
        </thead>
        <tbody>
          {shown.map((i) => {
            const href = toHash({ view: "item", source: i.source, id: i.id, tab: "lanes" })
            // A folder that only repeats the project name says nothing.
            const folder = i.project ? worktreeLabel({ path: i.project.worktree, branch: null }) : ""
            const branch = i.branch || (showProject && folder === i.project?.name ? "" : folder)
            return (
              <tr key={`${i.source}/${i.id}`} className={cn("group relative cursor-pointer border-b border-border/60 hover:bg-surface/60", i.open === false && "opacity-60")}>
                <td className="h-9 px-2">
                  {editing === `${i.source}/${i.id}` ? (
                    <div className="relative z-10">
                      <RenameForm
                        compact
                        source={i.source}
                        id={i.id}
                        title={i.title}
                        renamed={i.originalTitle !== undefined}
                        onDone={() => { setEditing(null); onChanged?.() }}
                        onCancel={() => setEditing(null)}
                      />
                    </div>
                  ) : (
                    <div className="flex min-w-0 items-center gap-1">
                      {/* The row is clickable through its title link (::after covers the row). */}
                      <a href={href} title={i.originalTitle ?? i.title ?? i.id} className="truncate font-medium text-foreground/90 after:absolute after:inset-0 after:content-[''] group-hover:text-foreground">
                        {i.title || i.id}
                      </a>
                      <IconAction label="Rename" className={HOVER} onClick={() => setEditing(`${i.source}/${i.id}`)}>
                        <Pencil />
                      </IconAction>
                      {i.resume && (
                        <CopyResume command={i.resume} open={i.open} className={HOVER} />
                      )}
                      <IconAction label={i.pinned ? "Unpin" : "Pin to the top"} className={i.pinned ? "relative z-10 text-foreground" : HOVER} onClick={() => mark(i, { pinned: !i.pinned })}>
                        {i.pinned ? <PinOff /> : <Pin />}
                      </IconAction>
                      <IconAction
                        label={i.archived ? (i.open ? "Unarchive (archived; hidden once it closes)" : "Unarchive") : i.open ? "Archive (hidden once it closes)" : "Archive"}
                        className={i.archived && i.open ? "relative z-10 text-foreground" : HOVER}
                        onClick={() => mark(i, { archived: !i.archived })}
                      >
                        {i.archived ? <ArchiveRestore /> : <Archive />}
                      </IconAction>
                    </div>
                  )}
                </td>
                <td className="px-2 py-1 font-mono text-xs leading-tight text-muted-foreground" title={[i.project?.name, branch].filter(Boolean).join(" · ")}>
                  {showProject && i.project && <div className="truncate text-foreground/80">{i.project.name}</div>}
                  {branch && <div className="truncate">{branch}</div>}
                </td>
                <td className="truncate px-2 font-mono text-xs text-muted-foreground">{i.harness}</td>
                <td className="px-2 whitespace-nowrap">
                  {i.open === false ? (
                    <span className="font-mono text-xs text-faint" title="No Claude Code process is running this session">closed</span>
                  ) : (
                    <span className={cn("inline-flex items-center gap-1.5", STATUS_TEXT[i.status])}>
                      <StatusDot status={i.status} live={i.live} labelled className="size-1.5" />
                      {STATUS_LABEL[i.status]}
                    </span>
                  )}
                </td>
                <td className="px-2 text-right font-mono tabular-nums text-muted-foreground">{i.counts.lanes}</td>
                <td className="px-2 text-right font-mono whitespace-nowrap tabular-nums text-muted-foreground">
                  {i.partial ? <span title="not counted until the session is opened">–</span> : i.counts.calls}
                  {!i.partial && i.counts.errors > 0 && <span className="ml-1 text-failed">{i.counts.errors} err<span className="sr-only">ors</span></span>}
                </td>
                <td className="px-2 text-right font-mono tabular-nums text-muted-foreground">{i.partial ? "–" : money(i.cost)}</td>
                <td
                  className={cn("px-2 text-right font-mono whitespace-nowrap tabular-nums", i.status === "looping" ? "text-looping" : "text-muted-foreground")}
                  title={i.sinceChange ? `${i.sinceChange.tokens.toLocaleString("en-US")} new tokens${i.sinceChange.cached ? ` (+${i.sinceChange.cached.toLocaleString("en-US")} cached)` : ""} since the last file change (${Math.round(i.sinceChange.ms / 60_000)} min)` : "not known until the session is opened"}
                >
                  {i.sinceChange ? compact(i.sinceChange.tokens) : "–"}
                </td>
                <td className="px-2 text-right font-mono tabular-nums text-faint" title={i.updatedAt ?? undefined}>
                  {ago(i.updatedAt, now)}
                </td>
              </tr>
            )
          })}
        </tbody>
      </table>
      {!all && rows.length > cap && (
        <button type="button" onClick={() => setAll(true)} className="mt-2 px-2 font-mono text-xs text-faint hover:text-foreground">
          Show all {rows.length}
        </button>
      )}
    </div>
  )
}
