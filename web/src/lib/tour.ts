import type { ItemSummary, Status } from "@/lib/api"

/**
 * The guided tour: a few steps over the page you already have, pointing at elements marked
 * `data-tour="<anchor>"`. The item steps open one of your own sessions, so what the tour explains is
 * on screen with your numbers, not a demo.
 */
export type TourStep = {
  id: string
  /** The `data-tour` value of the element to point at; none (or not on screen) shows the note centred. */
  anchor?: string
  /** Where the step happens: Home, or the tour's item on `tab`. */
  go?: { view: "home" } | { view: "item"; tab: string }
  title: string
  body: string
}

export const TOUR_DONE_KEY = "mission-control-tour"

const t = (ms: string | null | undefined) => (ms ? Date.parse(ms) || 0 : 0)

/**
 * The session the tour opens: a live one with subagents shows the most (lanes, map, calls across lanes),
 * then any live one, then the newest with subagents, then the newest. Hidden projects are left out.
 */
export function pickTourItem(items: ItemSummary[] | null | undefined): ItemSummary | null {
  const list = (items ?? []).filter((i) => !i.hidden)
  if (!list.length) return null
  const lanes = (i: ItemSummary) => i.counts?.lanes ?? 0
  const rank = (i: ItemSummary) => (i.live ? 2 : 0) + (lanes(i) > 1 ? 1 : 0)
  return [...list].sort((a, b) => rank(b) - rank(a) || t(b.updatedAt) - t(a.updatedAt))[0]
}

const STATUS_NOTE: Record<Status, string> = {
  working: "the model or one of its tools is running right now",
  waiting: "it is stopped on a permission prompt or a question for you",
  looping: "it is still running but keeps failing the same way, so it is burning tokens",
  idle: "nothing is running in it right now",
  done: "it finished",
  stopped: "it was stopped before it finished",
  failed: "it ended with an error",
}

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`

/** The steps, with the item steps written about `item` (left out when there is no session yet). */
export function tourSteps(item: ItemSummary | null): TourStep[] {
  const steps: TourStep[] = [
    {
      id: "welcome",
      title: "A quick tour of your dashboard",
      body: item
        ? `About a minute. It uses your own data and opens one of your sessions, "${short(item.title || item.id)}", to show what each part means. Use the arrow keys to move, Esc to stop.`
        : "About a minute, over your own data. Use the arrow keys to move, Esc to stop.",
    },
    {
      id: "chips",
      anchor: "chips",
      go: { view: "home" },
      title: "Status at a glance",
      body: "Needs you: a session is stopped on a permission prompt or a question. Looping: it keeps failing the same way. Ready: it finished and waits for your next prompt. Working: the model or a tool is running. Click a chip to filter everything by it; click again to clear.",
    },
    {
      id: "tree",
      anchor: "tree",
      title: "Projects are folders",
      body: "Sessions are grouped by the folder they run in, then by worktree and branch. A filled, pulsing dot means something is live there; a hollow dot means nothing is running in that folder right now. A tool that runs Claude for you (a Slack bot, a script) shows up under the folder it runs in, not under the tool's own repo.",
    },
    {
      id: "search",
      anchor: "search",
      title: "This box filters folders",
      body: "It matches project and branch names only, so a session title will not show here. To find a session by what it was about, use Search.",
    },
    {
      id: "palette",
      anchor: "palette",
      title: "Search finds sessions",
      body: "⌘K searches session titles, projects and branches, and opens any of them.",
    },
  ]
  if (item) {
    const lanes = item.counts?.lanes ?? 1
    const calls = item.counts?.calls ?? 0
    const subs = Math.max(0, lanes - 1)
    const where = [item.project?.name, item.branch].filter(Boolean).join(" · ")
    steps.push(
      {
        id: "status",
        anchor: "status",
        go: { view: "item", tab: "lanes" },
        title: "One session",
        body: `This is "${short(item.title || item.id)}"${where ? ` in ${where}` : ""}. The pill is its status: ${item.status === "idle" && item.ready ? "Ready, it finished and waits for your next prompt" : `${statusWord(item)}, ${STATUS_NOTE[item.status]}`}. ${item.live ? ' The "live" tag means it was active in the last few minutes.' : ""}`,
      },
      {
        id: "lanes",
        anchor: "tabs",
        title: "Lanes are who did the work",
        body:
          subs > 0
            ? `${plural(lanes, "lane")}: main is the session itself, and each of the ${plural(subs, "subagent")} it started gets its own lane with its own status. A subagent can be done while main keeps working.`
            : "Main is the session itself. When it starts subagents, each one gets its own lane with its own status, and the count here goes up.",
      },
      {
        id: "map",
        anchor: "map",
        go: { view: "item", tab: "map" },
        title: "The map",
        body: "The same lanes as a tree: main at the top, the subagents it started under it, coloured by status (green working, amber needs you, red failed, grey stopped or done). Click a lane to see its calls; the corner button opens it full screen.",
      },
      {
        id: "calls",
        anchor: "tab-calls",
        title: "Calls count every lane",
        body: `${calls ? `Calls ${calls}` : "Calls"} is every tool call in the session, main and subagents together, not main alone. It grows while the session runs, so two looks a minute apart can show different numbers.`,
      },
      {
        id: "rail",
        anchor: "rail",
        title: "What needs attention",
        body: "The side panel shows what this session is waiting on (and lets you answer when a source allows it), its health, and anything worth a look: loops, repeated errors, files another session is editing too.",
      },
    )
  }
  steps.push(
    {
      id: "freshness",
      anchor: "freshness",
      title: "Is this up to date?",
      body: '"live · 2s" is how long ago the server last answered; the page updates by itself. "stale · retrying" means the dashboard server stopped answering, so what you see may be old.',
    },
    {
      id: "remote",
      anchor: "remote",
      title: "Answer from your phone",
      body: "Remote lets a paired phone allow or deny a permission prompt, or pick an option, over your own tailnet. Off by default; the Remote page sets it up.",
    },
    {
      id: "end",
      anchor: "tour",
      title: "That's it",
      body: "Run the tour again any time from this button.",
    },
  )
  return steps
}

function statusWord(i: ItemSummary) {
  return i.status === "waiting" ? "needs you" : i.status
}

function short(s: string, n = 60) {
  const one = s.replace(/\s+/g, " ").trim()
  return one.length > n ? `${one.slice(0, n - 1)}…` : one
}

export type Box = { top: number; left: number; width: number; height: number }

/**
 * Where the note goes for a spotlight `target` in a `vw`×`vh` viewport: below when it fits, else above,
 * else beside; always inside the viewport with `gap` to spare. No target: centred.
 */
export function placeNote(target: Box | null, note: { width: number; height: number }, vw: number, vh: number, gap = 12): { top: number; left: number } {
  const clampX = (x: number) => Math.max(gap, Math.min(x, vw - note.width - gap))
  const clampY = (y: number) => Math.max(gap, Math.min(y, vh - note.height - gap))
  if (!target) return { top: clampY((vh - note.height) / 2), left: clampX((vw - note.width) / 2) }
  const centreX = clampX(target.left + target.width / 2 - note.width / 2)
  if (target.top + target.height + gap + note.height <= vh - gap) return { top: target.top + target.height + gap, left: centreX }
  if (target.top - gap - note.height >= gap) return { top: target.top - gap - note.height, left: centreX }
  const right = target.left + target.width + gap
  if (right + note.width <= vw - gap) return { top: clampY(target.top), left: right }
  return { top: clampY(target.top + target.height / 2 - note.height / 2), left: clampX(target.left - gap - note.width) }
}

export function tourDone(): boolean {
  try {
    return localStorage.getItem(TOUR_DONE_KEY) === "done"
  } catch {
    return false
  }
}

export function markTourDone() {
  try {
    localStorage.setItem(TOUR_DONE_KEY, "done")
  } catch {}
}
