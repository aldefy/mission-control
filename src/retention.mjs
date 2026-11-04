import { chmodSync, readFileSync, realpathSync, renameSync, statSync, unlinkSync, writeFileSync } from "node:fs"
import { join } from "node:path"

export const DEFAULT_DAYS = 30 // Claude Code's own default for cleanupPeriodDays
const MAX_DAYS = 3650

/**
 * How long Claude Code keeps session transcripts: `cleanupPeriodDays` in <configDir>/settings.json.
 * Only that key is written; a settings.json that is not valid JSON is never overwritten.
 */
export function createRetention(configDir) {
  const path = join(configDir, "settings.json")
  const read = () => {
    let text
    try { text = readFileSync(path, "utf8") } catch { return {} } // no settings.json yet
    const d = JSON.parse(text) // throws on a broken file: callers must not write over it
    if (!d || typeof d !== "object" || Array.isArray(d)) throw new Error("not a JSON object")
    return d
  }
  return {
    get() {
      try {
        const d = read().cleanupPeriodDays
        return { configDir, days: Number.isInteger(d) ? d : DEFAULT_DAYS, isDefault: !Number.isInteger(d) }
      } catch { return { configDir, days: null, isDefault: false, error: `${path} is not valid JSON` } }
    },
    set(days) {
      if (!Number.isInteger(days) || days < 1 || days > MAX_DAYS) throw { status: 400, message: `days must be a whole number from 1 to ${MAX_DAYS}` }
      let d
      try { d = read() } catch { throw { status: 409, message: `${path} is not valid JSON; not changing it` } }
      // A settings.json that is a symlink (a dotfiles repo) is written where it points, so the link stays.
      let target = path
      try { target = realpathSync(path) } catch { /* new file */ }
      let mode = 0o644
      try { mode = statSync(target).mode & 0o777 } catch { /* new file */ }
      const tmp = `${target}.${process.pid}.tmp`
      try {
        // The read above and this write run back to back (no await between), so the window in which a change
        // Claude Code makes to the file could be lost is as short as it gets without a lock.
        writeFileSync(tmp, JSON.stringify({ ...d, cleanupPeriodDays: days }, null, 2) + "\n", { mode })
        chmodSync(tmp, mode)
        renameSync(tmp, target)
      } catch (e) {
        try { unlinkSync(tmp) } catch { /* not created */ }
        throw e
      }
      return this.get()
    },
  }
}
