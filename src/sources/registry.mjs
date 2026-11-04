const OVERVIEW_POOL = 6

/** One place that fans out over every source. Later tasks add sources by passing more to createRegistry. */
export function createRegistry(sources, { titles = null, marks = null } = {}) {
  // A title the owner set on the page wins; the source's own stays as originalTitle. Pinned and archived
  // come from marks (an archived session that is open still shows; listed() hides it once it closes).
  const withOwnerEdits = (source, id, x) => {
    // A chat that changed session id keeps the rename given under its earlier id.
    const t = titles?.get(source, id) ?? (x.continuedFrom ? titles?.get(source, x.continuedFrom) : null)
    const m = marks?.get(source, id)
    return {
      ...x,
      ...(t ? { title: t, originalTitle: x.title } : {}),
      ...(m?.pinned ? { pinned: true } : {}),
      ...(m?.archived ? { archived: true } : {}),
    }
  }
  const byName = new Map()
  for (const s of sources) {
    // Two sources of one kind (two native dirs) keep distinct names: native, native-2, ...
    let name = s.name, n = 1
    while (byName.has(name)) name = `${s.name}-${++n}`
    byName.set(name, name === s.name ? s : { ...s, name })
  }
  const all = () => [...byName.values()]

  const errors = new Map() // source name -> last listItems failure
  // Requests that arrive together (overview, slim tree, items on one poll) share one listing.
  let listing = null
  function list() {
    listing ??= listAll().finally(() => { listing = null })
    return listing
  }
  async function listAll() {
    const lists = await Promise.all(
      all().map(async (s) => {
        try {
          const items = (await s.listItems()).map((i) => withOwnerEdits(s.name, i.id, { ...i, source: s.name }))
          errors.delete(s.name)
          return items
        } catch (e) {
          errors.set(s.name, String(e?.message ?? e))
          return [] // one broken source must not hide the others
        }
      }),
    )
    return lists.flat().sort((a, b) => String(b.updatedAt ?? "").localeCompare(String(a.updatedAt ?? "")))
  }

  async function get(source, id) {
    const s = byName.get(source)
    const item = s ? await s.getItem(id) : null
    return item ? { ...item, summary: withOwnerEdits(s.name, id, { ...item.summary, source: s.name }) } : null
  }

  /**
   * Status counts, what needs you, and what each live lane is doing now (newest first). `items`
   * (default: every item) lets the caller leave some out, such as hidden projects.
   */
  async function overview(items) {
    items ??= await list()
    // closed (open === false) is counted apart from its status, which stays idle.
    const counts = { waiting: 0, working: 0, stopped: 0, done: 0, ready: 0, looping: 0, closed: 0 }
    const ready = []
    for (const i of items) {
      if (i.open === false) counts.closed++
      if (i.ready && i.status !== "waiting") counts.ready++
      if (i.status === "waiting") counts.waiting++
      else if (i.status === "working") counts.working++
      else if (i.status === "looping") counts.looping++
      else if (i.status === "done") counts.done++
      else if (i.status === "stopped" || i.status === "failed") counts.stopped++
    }
    const where = (i) => ({ title: i.title, cwd: i.cwd ?? null, branch: i.branch ?? null, harness: i.harness, updatedAt: i.updatedAt ?? null, ...(i.project ? { project: i.project } : {}) })
    for (const i of items) if (i.ready && i.status !== "waiting") ready.push({ source: i.source, id: i.id, ...where(i), since: i.readySince ?? i.updatedAt ?? null })
    ready.sort((a, b) => String(b.since ?? "").localeCompare(String(a.since ?? "")))
    const needsYou = []
    const live = []
    const looping = []
    const busy = items.filter((x) => x.status === "waiting" || x.live || x.status === "working" || x.status === "looping")
    // Details load at most OVERVIEW_POOL at a time; results keep the list order.
    const details = new Array(busy.length)
    let next = 0
    await Promise.all(Array.from({ length: Math.min(OVERVIEW_POOL, busy.length) }, async () => {
      while (next < busy.length) {
        const k = next++
        try { details[k] = await get(busy[k].source, busy[k].id) } catch { details[k] = null }
      }
    }))
    for (const [k, i] of busy.entries()) {
      const d = details[k]
      if (i.status === "waiting") {
        const lane = d?.lanes.find((l) => l.status === "waiting")
        const ask = lane?.ask ?? {}
        needsYou.push({
          source: i.source, id: i.id, ...where(i), lane: lane?.id ?? "", detail: lane?.reason ?? "",
          // The prompt's identity: when it was asked, and the tool and target it is about (when known).
          since: ask.since ?? null, tool: ask.tool ?? null, target: ask.target ?? null,
          // v2.3: the hook session a pending remote prompt is joined on (Claude: the item id; Codex: the
          // session_id its hook log is keyed by), and the tool call it is about when the hooks know it.
          ...(i.harness === "claude-code" || i.harness === "codex" ? { sessionId: d?.summary.sessionId ?? i.sessionId ?? i.id } : {}),
          ...(typeof ask.callId === "string" ? { callId: ask.callId } : {}),
        })
      }
      // The listing may lag the detail by a poll: the detail (just parsed) decides working vs looping.
      const st = d?.summary.status
      if (st === "looping" && i.status === "working") { counts.working--; counts.looping++ }
      else if (st === "working" && i.status === "looping") { counts.looping--; counts.working++ }
      const loop = d?.summary.loop ?? (st ? null : i.loop)
      if ((st ?? i.status) === "looping" && loop) looping.push({ source: i.source, id: i.id, ...where(i), lane: loop.lane ?? "", loop, sinceChange: d?.summary.sinceChange ?? i.sinceChange ?? null })
      for (const l of d?.lanes ?? []) {
        if (l.status !== "working" && l.status !== "looping") continue
        live.push({ source: i.source, id: i.id, ...where(i), lane: l.id, label: l.label, kind: l.kind, model: l.model ?? null, nowDoing: l.nowDoing ?? null, startedAt: l.startedAt ?? null, ...(l.status === "looping" ? { looping: true } : {}) })
      }
    }
    const at = (l) => String(l.nowDoing?.ts ?? l.startedAt ?? l.updatedAt ?? "")
    live.sort((a, b) => at(b).localeCompare(at(a)))
    looping.sort((a, b) => String(a.loop.since ?? "").localeCompare(String(b.loop.since ?? "")))
    return { counts, needsYou, ready, looping, live }
  }

  return {
    list,
    get,
    overview,
    sources: all,
    /** What /api/events watches: every source's hook dirs and live files (sources without watchTargets add nothing). */
    watchTargets() {
      const dirs = new Set(), files = new Set()
      for (const s of all()) {
        try {
          const t = s.watchTargets?.() ?? {}
          for (const d of t.dirs ?? []) dirs.add(d)
          for (const f of t.files ?? []) files.add(f)
        } catch { /* one source must not stop the feed */ }
      }
      return { dirs: [...dirs], files: [...files] }
    },
    error: (name) => errors.get(name) ?? null,
    source: (name) => byName.get(name) ?? null,
    async calls(source, id, filter) {
      const s = byName.get(source)
      return s ? s.getCalls(id, filter ?? {}) : []
    },
    /** Chat turns of one lane; null when the source has no transcript turns or the item/lane is unknown. */
    async turns(source, id, lane, page) {
      const s = byName.get(source)
      return s?.getTurns ? s.getTurns(id, lane, page) : null
    },
    async session(source, id, name) {
      const s = byName.get(source)
      return s ? s.getSession(id, name) : null
    },
    /** True when every source that scans in the background has finished its first pass. */
    usageComplete: () => all().every((s) => !s.usageStatus || s.usageStatus().complete),
    async usage(range = {}) {
      const rows = await Promise.all(all().map((s) => (s.usage ? s.usage(range).catch(() => []) : [])))
      return rows.flat()
    },
  }
}
