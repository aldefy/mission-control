import { mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs"
import { dirname } from "node:path"

/**
 * Pinned and archived flags the owner set from the page, keyed "<source>:<id>": { pinned?, archived? }.
 * Our own file, like titles.json, re-read when it changes so dashboards sharing it agree.
 */
export function createMarks(path) {
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
    get(source, id) {
      const m = load()[`${source}:${id}`]
      return { pinned: m?.pinned === true, archived: m?.archived === true }
    },
    /** Merge `{ pinned?, archived? }` booleans into an item's marks; returns the marks now in effect. */
    set(source, id, patch) {
      if (!path) throw { status: 501, message: "marks are off" }
      const key = `${source}:${id}`
      const next = { ...load() }
      const m = { ...next[key] }
      for (const k of ["pinned", "archived"]) if (typeof patch[k] === "boolean") m[k] = patch[k]
      if (m.pinned || m.archived) next[key] = { ...(m.pinned ? { pinned: true } : {}), ...(m.archived ? { archived: true } : {}) }
      else delete next[key]
      mkdirSync(dirname(path), { recursive: true, mode: 0o700 })
      const tmp = `${path}.${process.pid}.tmp`
      writeFileSync(tmp, JSON.stringify(next, null, 2) + "\n", { mode: 0o600 })
      renameSync(tmp, path)
      return { pinned: !!m.pinned, archived: !!m.archived }
    },
  }
}
