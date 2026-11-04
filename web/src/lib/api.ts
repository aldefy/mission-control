import { useCallback, useEffect, useReducer, useState } from "react"
import { markFail, markOk } from "@/lib/freshness"
import { onServerChange } from "@/lib/server-events"

export type Capabilities = { adapter: string; extras: string[]; actions: string[]; source: string | null }
export type RunSummary = {
  id: string
  idea: string
  repo?: string
  live: boolean
  /** The run's current stop is an owner stop (src/status.mjs). */
  waiting?: boolean
  stages: Record<string, { status: string; rounds?: number }>
  harness?: string
}
export type RunDetail = { state: Record<string, any>; events: Record<string, any>[]; live: boolean }

export type Remote<T> = { data: T | null; error: string | null; loading: boolean; reload: () => void }

export type FetchState<T> = { url: string | null; data: T | null; error: string | null; loading: boolean }
export type FetchAction<T> =
  | { type: "reset"; url: string | null }
  | { type: "ok"; url: string; data: T }
  | { type: "fail"; url: string; error: string }

export const initialFetch = <T,>(url: string | null): FetchState<T> => ({
  url,
  data: null,
  error: null,
  loading: url !== null,
})

/** State for `url`. Anything recorded for a different url is discarded; a poll on the same url keeps data. */
export function fetchReducer<T>(state: FetchState<T>, action: FetchAction<T>): FetchState<T> {
  if (action.type === "reset") return action.url === state.url ? state : initialFetch<T>(action.url)
  if (action.url !== state.url) return state
  if (action.type === "ok") return { url: state.url, data: action.data, error: null, loading: false }
  return { ...state, error: action.error, loading: false }
}

type FetchLike = (url: string, init?: RequestInit) => Promise<Pick<Response, "ok" | "status" | "json"> & Partial<Pick<Response, "text" | "headers">>>

class HttpError extends Error {}

/**
 * One url's loader. `load()` does nothing while a request is in flight (a slow answer never stacks
 * polls), sends the last ETag as If-None-Match, and calls `onData` only when the payload changed:
 * a 304 or an identical body is dropped, so an unchanged poll costs no render.
 */
export function createLoader<T>(url: string, onData: (d: T) => void, onError: (e: string) => void, fetchImpl: FetchLike = fetch) {
  let inFlight = false
  let etag: string | null = null
  let last: string | null = null
  return async function load(): Promise<void> {
    if (inFlight) return
    inFlight = true
    try {
      const r = etag ? await fetchImpl(url, { headers: { "if-none-match": etag } }) : await fetchImpl(url)
      if (r.status === 304) {
        markOk()
        return
      }
      if (!r.ok) {
        const j: { error?: string } | null = await Promise.resolve(r.json?.()).catch(() => null)
        markOk() // reachable, just an error answer
        throw new HttpError(j?.error ?? `${url}: ${r.status}`)
      }
      markOk() // the server answered; a 4xx above is the item's problem, not the connection's
      const tag = r.headers?.get("etag") ?? null
      if (typeof r.text === "function") {
        const text = await r.text()
        etag = tag
        if (text === last) return
        last = text
        onData(JSON.parse(text) as T)
      } else onData((await r.json()) as T)
    } catch (e: any) {
      // Forget what we had: the next good answer must dispatch (and so clear the error), even if unchanged.
      etag = null
      last = null
      if (!(e instanceof HttpError)) markFail()
      onError(String(e?.message ?? e))
    } finally {
      inFlight = false
    }
  }
}

/**
 * GET `url` (null: nothing), every `pollMs` while the page is visible (0: once), and once more when it
 * becomes visible again. `refresh`: any value; when it changes the url is fetched again (data kept until
 * the answer). One request at a time; a 304 or an identical body is dropped; any good answer clears an error.
 */
export function useFetch<T>(url: string | null, pollMs = 0, refresh: unknown = 0): Remote<T> {
  const [raw, dispatch] = useReducer(fetchReducer<T>, url, initialFetch<T>)
  const [tick, setTick] = useState(0)
  const reload = useCallback(() => setTick((n) => n + 1), [])
  // never expose results recorded for a previous url
  const state = raw.url === url ? raw : initialFetch<T>(url)

  useEffect(() => {
    dispatch({ type: "reset", url })
    if (url === null) return
    let cancelled = false
    let timer: ReturnType<typeof setInterval> | undefined
    const load = createLoader<T>(
      url,
      (data) => !cancelled && dispatch({ type: "ok", url, data }),
      (error) => !cancelled && dispatch({ type: "fail", url, error }),
    )
    const start = () => {
      if (pollMs && timer === undefined) timer = setInterval(load, pollMs)
    }
    const stop = () => {
      if (timer !== undefined) clearInterval(timer)
      timer = undefined
    }
    const onVis = () => {
      if (document.hidden) stop()
      else {
        void load()
        start()
      }
    }
    void load()
    if (!document.hidden) start()
    if (pollMs) document.addEventListener("visibilitychange", onVis)
    // A polled url also refetches the moment the server says something changed (SSE); polling stays as the fallback.
    const off = pollMs ? onServerChange(() => { if (!document.hidden) void load() }) : () => {}
    return () => {
      cancelled = true
      off()
      stop()
      document.removeEventListener("visibilitychange", onVis)
    }
  }, [url, pollMs, tick, refresh])

  return { data: state.data, error: state.error, loading: state.loading, reload }
}

const POLL = 2000

export const useCapabilities = () => useFetch<Capabilities>("/api/capabilities")
export const useRuns = () => useFetch<RunSummary[]>("/api/runs", POLL)
export const useRun = (id: string | null) =>
  useFetch<RunDetail>(id ? `/api/run/${encodeURIComponent(id)}` : null, POLL)
/** A session transcript by file name (`name` null: nothing to load). */
export const useSession = (id: string, name: string | null) =>
  useFetch<{ text: string; truncated?: boolean }>(
    name ? `/api/run/${encodeURIComponent(id)}/session/${encodeURIComponent(name)}` : null,
  )
export const useCrew = (repo?: string) =>
  useFetch<any>(`/api/crew${repo ? `?repo=${encodeURIComponent(repo)}` : ""}`)
/** An adapter extra. `refresh` reloads it when it changes; run-scoped extras pass `runChanges(events)`. */
export function useExtra<T>(key: string, id?: string | null, query?: Record<string, string>, refresh: unknown = 0) {
  const qs = query ? `?${new URLSearchParams(query)}` : ""
  return useFetch<T>(`/api/x/${encodeURIComponent(key)}${id ? `/${encodeURIComponent(id)}` : ""}${qs}`, 0, refresh)
}

export async function postAction(id: string, name: string, body: object = {}) {
  const r = await fetch(`/api/run/${encodeURIComponent(id)}/action/${encodeURIComponent(name)}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  })
  const j = await r.json().catch(() => ({}))
  if (!r.ok) throw new Error(j.error ?? j.message ?? `action ${name}: ${r.status}`)
  return j
}

// ---- v2: one set of routes for every source ----

export type Status = "working" | "waiting" | "looping" | "stopped" | "failed" | "done" | "idle"
/** Tokens and time since the last successful file change (Edit, Write, apply_patch...). */
/** New tokens (input + output + cache write) and, apart, cache reads since the last file change. */
export type SinceChange = { tokens: number; cached?: number; since: string | null; ms: number }
/** Why a lane counts as looping (src/loops.mjs): since when, how many failures, cost since, the first failing call. */
export type LoopInfo = { looping: true; rule: "repeat" | "cycle" | "burn"; since: string; failures: number; costSince: number; firstCallId: string; reason: string; command: string; lane?: string }
export type Tokens = { in: number; out: number; cacheRead: number; cacheWrite: number }
export type ItemSummary = {
  source: string
  id: string
  kind: "run" | "session"
  title: string
  /** The source's own title, present when the owner renamed the item on the page. */
  originalTitle?: string
  harness: string
  cwd: string | null
  branch: string | null
  live: boolean
  status: Status
  waiting: boolean
  startedAt: string | null
  updatedAt: string | null
  counts: { lanes: number; calls: number; errors: number }
  tokens: Tokens
  cost: number
  /** Calls, errors, tokens and cost are not known yet (listed from file heads only). */
  partial?: boolean
  /** Set by /api/items: the project and worktree the item's cwd belongs to. */
  project?: Placed
  /** Its project is hidden (noise) by default. */
  hidden?: boolean
  /** Done and waiting for your next prompt (Claude's idle reminder, or a Codex turn that ended < 30 min ago). */
  ready?: boolean
  readySince?: string
  sinceChange?: SinceChange
  loop?: LoopInfo
  /** A process is still running this session (false: closed). Absent when the source cannot tell. */
  open?: boolean
  /** The chat continues under this newer session id; this one is its earlier part (not listed). */
  parkedInto?: string
  /** The earlier session id of the same chat. */
  continuedFrom?: string
  /** Claude Code's latest recap of the session (written when you come back to it), item detail only. */
  recap?: { text: string; ts: string | null }
  /** Shell command that resumes the session in its folder (Claude Code only). */
  resume?: string
  /** Pinned by the owner: listed first. */
  pinned?: boolean
  /** Archived by the owner (and not open): left out of lists and counts unless asked for. */
  archived?: boolean
}
export type Placed = { key: string; name: string; worktree: string }
export type Lane = {
  id: string
  label: string
  kind: "main" | "subagent" | "stage" | "crew"
  status: Status
  model?: string
  nowDoing?: { name: string; kind: string; summary: string; ts: string }
  reason?: string
  /** The open prompt of a waiting lane: when it was asked, the tool and its command or path. */
  ask?: { since?: string; tool?: string; target?: string }
  loop?: LoopInfo
  sinceChange?: SinceChange
  calls: number
  errors: number
  tokens: Tokens
  cost: number
  parent?: string
  startedAt?: string
  endedAt?: string
}
export type Call = {
  id: string
  lane: string
  ts: string
  name: string
  kind: "tool" | "mcp" | "skill" | "agent"
  server?: string
  summary: string
  input?: unknown
  ok?: boolean
  error?: string
  durationMs?: number
  /** A short result text. */
  result?: string
  /** Agent calls: the lane the sub-agent ran in, when known. */
  subLane?: string
}
export type CallKind = Call["kind"]
/** A tool use inside a chat turn: what was asked and what came back. */
export type ToolChip = Pick<Call, "id" | "name" | "kind" | "server" | "summary" | "input" | "ok" | "error" | "durationMs" | "result">
export type Turn = { i: number; role: "user" | "assistant"; ts: string | null; text: string; tools: ToolChip[] }
/** Turns [start, start + turns.length) of `total` in one lane's transcript. */
export type TurnPage = { lane: string; total: number; start: number; turns: Turn[] }
export type ItemDetail = { summary: ItemSummary; lanes: Lane[]; events: Record<string, any>[]; state?: Record<string, any> }
type Where = { source: string; id: string; title: string; cwd: string | null; branch: string | null; harness: string; updatedAt: string | null; project?: Placed }
/** `since`, `tool`, `target`: the prompt's identity (when it was asked, the tool and its command or path), when known. */
export type NeedsYou = Where & { lane: string; detail: string; since?: string | null; tool?: string | null; target?: string | null }
export type LiveLane = Where & {
  lane: string
  label: string
  kind: Lane["kind"]
  model: string | null
  nowDoing: Lane["nowDoing"] | null
  startedAt: string | null
}
/** A session that is done and waiting for your next prompt: not urgent, but findable. */
export type ReadyItem = Where & { since: string | null }
/** An item looping now, with its looping lane's loop. */
export type LoopingItem = Where & { lane: string; loop: LoopInfo; sinceChange: SinceChange | null }
export type Overview = {
  counts: { waiting: number; working: number; stopped: number; done: number; ready?: number; looping?: number; closed?: number }
  needsYou: NeedsYou[]
  ready?: ReadyItem[]
  looping?: LoopingItem[]
  live: LiveLane[]
  /** Items left out because their project is hidden. */
  hidden: number
}
/** `closed` items are also counted in their status (idle). */
export type StatusCounts = Record<Status, number> & { items: number; live: number; ready?: number; closed?: number }
/** A worktree as the sidebar sees it (`/api/projects?slim=1`): counts, no item list. */
export type WorktreeSummary = {
  path: string
  branch: string | null
  live: boolean
  waiting: boolean
  dirty?: number
  ahead?: number
  behind?: number
  counts: StatusCounts
  /** Items done today in the viewer's zone. */
  doneToday: number
  updatedAt: string | null
}
export type ProjectSummary = { key: string; name: string; path: string; hidden?: boolean; worktrees: WorktreeSummary[] }
export type WorktreeNode = WorktreeSummary & { items: ItemSummary[] }
export type ProjectNode = { key: string; name: string; path: string; hidden?: boolean; worktrees: WorktreeNode[] }
export type SourceInfo = { name: string; harness: string; extras: string[]; actions: string[]; source: string | null; error?: string }
export type UsageBy = "model" | "project" | "harness" | "day" | "worktree" | "branch"
export type UsageQuery = { from?: string; to?: string; by?: UsageBy }
type UsageSums = Tokens & { cost: number; sessions: number }
export type UsageResult = {
  totals: UsageSums
  series: (UsageSums & { day: string; byKey: Record<string, number> })[]
  groups: (UsageSums & { key: string; name?: string })[]
  by: UsageBy
  tz: string
  from: string | null
  to: string | null
  complete: boolean
}
export type UsageDay = UsageResult["series"][number]
export type UsageGroup = UsageResult["groups"][number]
export type CallFilter = { lane?: string; kind?: string; q?: string }

const qs = (q: Record<string, string | undefined>) => {
  const p = new URLSearchParams()
  for (const [k, v] of Object.entries(q)) if (v) p.set(k, v)
  const s = p.toString()
  return s ? `?${s}` : ""
}

/** The viewer's IANA zone; usage days are bucketed in it. */
export const browserTz = () => Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC"
export const itemUrl = (source: string, id: string) => `/api/item/${encodeURIComponent(source)}/${encodeURIComponent(id)}`
export const callsUrl = (source: string, id: string, f: CallFilter = {}) =>
  `${itemUrl(source, id)}/calls${qs({ lane: f.lane, kind: f.kind, q: f.q })}`
export const turnsUrl = (source: string, id: string, lane: string, page: { before?: number; limit?: number } = {}) =>
  `${itemUrl(source, id)}/turns${qs({ lane, before: page.before === undefined ? undefined : String(page.before), limit: page.limit === undefined ? undefined : String(page.limit) })}`
export const usageUrl = (q: UsageQuery, tz: string) => `/api/usage${qs({ from: q.from, to: q.to, by: q.by ?? "model", tz })}`

const PROJECTS_POLL = 5000

/** Overview counts leave hidden projects out unless `all`. */
export const overviewUrl = (all = false) => `/api/overview${all ? "?all=1" : ""}`
export const projectsUrl = (tz: string) => `/api/projects${qs({ slim: "1", tz })}`
export const projectUrl = (key: string, tz: string) => `/api/project/${encodeURIComponent(key)}${qs({ tz })}`
export const itemsUrl = (q: { all?: boolean; archived?: boolean; limit?: number; source?: string; id?: string } = {}) =>
  `/api/items${qs({ all: q.all ? "1" : undefined, archived: q.archived ? "1" : undefined, limit: q.limit === undefined ? undefined : String(q.limit), source: q.source, id: q.id })}`

export const useOverview = (all = false) => useFetch<Overview>(overviewUrl(all), POLL)
export const useSources = () => useFetch<SourceInfo[]>("/api/sources")
/** The slim project tree (counts per worktree, no items) for the sidebar and chips. Share it via ProjectsProvider. */
export const useProjects = () => useFetch<ProjectSummary[]>(projectsUrl(browserTz()), PROJECTS_POLL)
/** One project with its items: only for the open project page. */
export const useProject = (key: string | null) => useFetch<ProjectNode>(key ? projectUrl(key, browserTz()) : null, PROJECTS_POLL)
/** Items with their project; `poll` false loads once (the palette, a crumb lookup). */
export const useItems = (q: Parameters<typeof itemsUrl>[0] = {}, enabled = true, poll = true) =>
  useFetch<ItemSummary[]>(enabled ? itemsUrl(q) : null, poll ? POLL : 0)
/** One item: summary, lanes, events (and a run's state). `pollMs` 0 loads once. */
export const useItem = (source: string, id: string | null, pollMs = POLL) => useFetch<ItemDetail>(id ? itemUrl(source, id) : null, pollMs)
/** An item's calls (all of them unless filtered; the Calls tab filters client-side so chip counts stay exact). */
export const useCalls = (source: string, id: string | null, f: CallFilter = {}, pollMs = POLL) =>
  useFetch<Call[]>(id ? callsUrl(source, id, f) : null, pollMs)

export type UsageRemote = Remote<UsageResult> & {
  /** true when `data` is the last answer for a different url, kept on screen while `url` loads or after it failed */
  stale: boolean
}

/** The `by` of a usage url: answers are only ever kept across urls of the same kind. */
export const usageKind = (url: string | null) => (url === null ? null : new URL(url, "http://local").searchParams.get("by"))

/**
 * GET /api/usage at `url` (build it with `usageUrl`; null loads nothing), every `pollMs` while set. While a new
 * url of the same `by` loads (or fails), the last answer stays as `data` with `stale`; an answer for a
 * different `by` is never reused.
 */
export function useUsage(url: string | null, pollMs = 0): UsageRemote {
  const r = useFetch<UsageResult>(url, pollMs)
  const [kept, setKept] = useState<{ kind: string | null; data: UsageResult } | null>(null)
  useEffect(() => {
    if (r.data && url !== null) setKept({ kind: usageKind(url), data: r.data })
  }, [r.data, url])
  const stale = !r.data && url !== null && kept !== null && kept.kind === usageKind(url)
  return { ...r, data: r.data ?? (stale ? kept!.data : null), stale }
}

export async function postItemAction(source: string, id: string, name: string, body: object = {}) {
  const r = await fetch(`${itemUrl(source, id)}/action/${encodeURIComponent(name)}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  })
  const j = await r.json().catch(() => ({}))
  if (!r.ok) throw new Error(j.error ?? j.message ?? `action ${name}: ${r.status}`)
  return j
}

/** Rename an item on the page; an empty title restores the source's own. */
export async function postTitle(source: string, id: string, title: string) {
  const r = await fetch(`${itemUrl(source, id)}/title`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ title }),
  })
  const j = await r.json().catch(() => ({}))
  if (!r.ok) throw new Error(j.error ?? `rename: ${r.status}`)
  return j as { title: string | null }
}

/** Pin or archive an item (either flag may be left out). */
export async function postMark(source: string, id: string, patch: { pinned?: boolean; archived?: boolean }) {
  const r = await fetch(`${itemUrl(source, id)}/mark`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(patch),
  })
  const j = await r.json().catch(() => ({}))
  if (!r.ok) throw new Error(j.error ?? `mark: ${r.status}`)
  return j as { pinned: boolean; archived: boolean }
}

export type ActionNote = { ok: boolean; text: string }

/**
 * What an action's answer means for the person who clicked. A source that resumes the run says
 * `resumed: false` (with `error`) when the resume could not start: the action landed, the run did not move.
 */
export function actionNote(done: string, result: any): ActionNote {
  if (result && result.resumed === false) {
    return { ok: false, text: `${done}, but the run could not resume${result.error ? `: ${result.error}` : "."}` }
  }
  return { ok: true, text: `${done}.` }
}
