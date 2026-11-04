import { useMemo, useState } from "react"
import { useProject, type ItemSummary, type ProjectNode, type Status } from "@/lib/api"
import { useProjectConfig, useProjectConflicts } from "@/lib/api-v22"
import { SameFileWarnings } from "@/components/SameFileWarnings"
import { ago, useNow } from "@/lib/format"
import { useShared } from "@/lib/projects-context"
import { toHash } from "@/lib/route"
import { matchesFilter, rollupCounts, worktreeLabel } from "@/lib/tree"
import { ItemTable } from "@/components/ItemTable"
import { WorktreeCard } from "@/components/WorktreeCard"
import { Panel, Strip, StripCell } from "@/components/Panel"
import { Retry } from "@/components/Retry"
import { StatusDot } from "@/components/StatusDot"
import { STATUS_UI } from "@/lib/status-ui"
import { cn } from "@/lib/utils"

/** A project's items, each carrying its worktree's branch when it has none of its own. */
export function projectItems(p: ProjectNode, worktree?: string): ItemSummary[] {
  return p.worktrees
    .filter((w) => worktree === undefined || w.path === worktree)
    .flatMap((w) => w.items.map((i) => ({ ...i, branch: i.branch ?? w.branch, project: { key: p.key, name: p.name, worktree: w.path } })))
}

/**
 * A project: its worktrees as cards (branch, dirty files, ahead/behind, live lanes, last activity) and
 * its runs and sessions. With `worktree`, the same page narrowed to that one worktree.
 */
export default function ProjectPage({ projectKey, worktree }: { projectKey: string; worktree?: string }) {
  const project = useProject(projectKey)
  const cfg = useProjectConfig(projectKey)
  const conflicts = useProjectConflicts(projectKey)
  const { overview, filter } = useShared()
  const [idleShown, setIdleShown] = useState(false)
  const now = useNow()
  const p = project.data
  const lanes = useMemo(() => (overview.data?.live ?? []).filter((l) => l.project?.key === projectKey), [overview.data, projectKey])
  const items = useMemo(() => (p ? projectItems(p, worktree).filter((i) => matchesFilter(i, filter)) : []), [p, worktree, filter])

  if (!p) {
    if (project.error)
      return /404/.test(project.error) ? (
        <p className="text-sm text-muted-foreground">No such project (it has no sessions or runs now).</p>
      ) : (
        <div role="alert" className="flex flex-wrap items-center gap-3 text-sm text-failed">
          Could not load the project: {project.error}
          <Retry onRetry={project.reload} />
        </div>
      )
    return <div className="h-40 animate-pulse rounded-xl border bg-card/50" aria-label="loading project" />
  }

  const wt = worktree === undefined ? null : (p.worktrees.find((w) => w.path === worktree) ?? null)
  const cards = worktree === undefined ? p.worktrees : wt ? [wt] : []
  const used = cards.filter((w) => w.counts.items || w.live)
  const idle = cards.length - used.length
  const shownCards = idleShown || worktree !== undefined ? cards : used
  const totals = p.worktrees.reduce((n, w) => n + w.counts.items, 0)

  const sum = (k: Status) => cards.reduce((n, w) => n + w.counts[k], 0)
  const last = cards.map((w) => w.updatedAt).filter((t): t is string => !!t).sort().at(-1) ?? null
  const status = rollupCounts(cards.map((w) => w.counts))
  const live = cards.some((w) => w.live)
  const dirty = cards.reduce((n, w) => n + (w.dirty ?? 0), 0)

  return (
    <div className="flex flex-col gap-4">
      <header className="flex flex-wrap items-center gap-x-3 gap-y-1">
        <h1 className="min-w-0 truncate text-lg font-bold tracking-tight">{wt ? worktreeLabel(wt) : p.name}</h1>
        <span className="min-w-0 truncate font-mono text-xs text-faint">
          {wt ? (
            <>
              <a href={toHash({ view: "project", key: p.key })} className="hover:text-foreground">
                {p.name}
              </a>{" "}
              · {wt.path}
            </>
          ) : (
            p.path || "(no folder)"
          )}
        </span>
        {p.hidden && <span className="rounded bg-secondary px-1.5 py-0.5 font-mono text-xs text-muted-foreground">hidden by default</span>}
        <span className={cn("ml-auto flex items-center gap-1.5 rounded-full border px-2 py-0.5 font-mono text-xs", STATUS_UI[status].border, STATUS_UI[status].text)}>
          <StatusDot status={status} live={live} labelled />
          {STATUS_UI[status].label}
        </span>
      </header>

      <Strip label="Project summary" className="grid-cols-2 sm:grid-cols-4 xl:grid-cols-8">
        <StripCell k={wt ? "Worktree" : "Worktrees"}>{wt ? 1 : p.worktrees.length}</StripCell>
        <StripCell k="Runs + sessions">{wt ? wt.counts.items : totals}</StripCell>
        <StripCell k="Needs you" className={sum("waiting") ? "text-needs-you" : undefined}>{sum("waiting")}</StripCell>
        <StripCell k="Working" className={sum("working") ? "text-running" : undefined}>{sum("working")}</StripCell>
        <StripCell k="Lanes working" className={lanes.length ? "text-running" : undefined}>{lanes.filter((l) => !wt || l.project?.worktree === wt.path).length}</StripCell>
        <StripCell k="Failed" className={sum("failed") ? "text-failed" : undefined}>{sum("failed")}</StripCell>
        <StripCell k="Changed files" tip="Uncommitted files over these worktrees">{dirty ? `±${dirty}` : "0"}</StripCell>
        <StripCell k="Last activity" tip={last ?? undefined}>{last ? ago(last, now) : "–"}</StripCell>
      </Strip>

      <SameFileWarnings warnings={conflicts.data?.warnings ?? []} />

      {cfg.data && cfg.data.unusedServers.length > 0 && (
        <p data-unused-servers className="rounded-lg border bg-card px-4 py-2 text-xs text-muted-foreground">
          <span className="font-medium text-foreground">Unused MCP servers</span> · configured but not called in the last {cfg.data.sessions} session{cfg.data.sessions === 1 ? "" : "s"}:{" "}
          <span className="font-mono">{cfg.data.unusedServers.map((s) => s.name).join(", ")}</span>
          <span className="text-faint"> · each loads its tools into every session's context</span>
        </p>
      )}

      {worktree !== undefined && !wt && <p className="text-sm text-muted-foreground">This worktree has no runs or sessions now.</p>}

      {shownCards.length > 0 && (
        <Panel
          title={wt ? "Worktree" : "Worktrees"}
          count={wt ? undefined : shownCards.length}
          aside={
            idle > 0 && (
              <button type="button" onClick={() => setIdleShown((v) => !v)} className="min-h-6 font-mono text-xs text-faint hover:text-foreground">
                {idleShown ? "hide idle worktrees" : `+ ${idle} idle worktree${idle === 1 ? "" : "s"}`}
              </button>
            )
          }
          bodyClassName="grid grid-cols-[repeat(auto-fill,minmax(300px,1fr))] gap-3"
        >
          {shownCards.map((w) => (
            <WorktreeCard key={w.path} projectKey={p.key} w={w} lanes={lanes.filter((l) => l.project?.worktree === w.path)} now={now} />
          ))}
        </Panel>
      )}

      <Panel
        title="Runs and sessions"
        count={items.length}
        aside={filter && <span className="font-mono text-xs text-faint">filtered by the status chip</span>}
        bodyClassName="p-2"
      >
        <ItemTable items={items} showProject={false} now={now} onChanged={project.reload} empty={filter ? "Nothing here matches the status filter" : "No runs or sessions yet"} />
      </Panel>
    </div>
  )
}
