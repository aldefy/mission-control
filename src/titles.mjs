import { mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs"
import { dirname } from "node:path"

export const MAX_TITLE = 160

/**
 * Titles the owner set from the page, keyed "<source>:<id>". Kept in our own file so the sources stay
 * read-only; re-read when the file changes, so two dashboards sharing it see each other's renames.
 */
export function createTitles(path) {
  let seen = null, map = {}
  function load() {
    if (!path) return map
    let st
    try { st = statSync(path) } catch { seen = null; map = {}; return map }
    const stamp = `${st.mtimeMs}|${st.size}`
    if (stamp === seen) return map
    seen = stamp
    try {
      const raw = JSON.parse(readFileSync(path, "utf8"))
      map = raw && typeof raw === "object" && !Array.isArray(raw) ? raw : {}
    } catch { map = {} }
    return map
  }
  return {
    get: (source, id) => {
      const t = load()[`${source}:${id}`]
      return typeof t === "string" && t ? t : null
    },
    /** An empty title clears the rename. Returns the title now in effect from this file, or null. */
    set(source, id, title) {
      if (!path) throw { status: 501, message: "renaming is off" }
      const next = { ...load() }
      const t = String(title ?? "").replace(/\s+/g, " ").trim().slice(0, MAX_TITLE)
      if (t) next[`${source}:${id}`] = t
      else delete next[`${source}:${id}`]
      mkdirSync(dirname(path), { recursive: true, mode: 0o700 })
      const tmp = `${path}.${process.pid}.tmp`
      writeFileSync(tmp, JSON.stringify(next, null, 2) + "\n", { mode: 0o600 })
      renameSync(tmp, path)
      return t || null
    },
  }
}
