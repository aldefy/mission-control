import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs"
import { homedir } from "node:os"
import { dirname, join } from "node:path"

export const defaultSettingsPath = () => join(homedir(), ".mission-control", "settings.json")

// notify: a session needs you; notifyDone: a session finished its prompt (working -> idle); both off until
// turned on in the sidebar. notifyDismiss: seconds a page notification stays before it closes itself (0: until dismissed).
const DEFAULTS = { notify: false, notifyDone: false, notifyDismiss: 10 }

/** Page-set preferences ({ notify, notifyDone, notifyDismiss }), shared by every dashboard on the machine. null path: defaults only. */
export function createSettings(path) {
  const read = () => {
    try { return { ...DEFAULTS, ...JSON.parse(readFileSync(path, "utf8")) } } catch { return { ...DEFAULTS } }
  }
  return {
    get: () => (path ? read() : { ...DEFAULTS }),
    set(patch) {
      if (!path) throw { status: 501, message: "settings are off" }
      const next = { ...read() }
      for (const k of ["notify", "notifyDone"]) if (typeof patch[k] === "boolean") next[k] = patch[k]
      if (Number.isInteger(patch.notifyDismiss) && patch.notifyDismiss >= 0 && patch.notifyDismiss <= 600) next.notifyDismiss = patch.notifyDismiss
      mkdirSync(dirname(path), { recursive: true, mode: 0o700 })
      const tmp = `${path}.${process.pid}.tmp`
      writeFileSync(tmp, JSON.stringify(next, null, 2) + "\n", { mode: 0o600 })
      renameSync(tmp, path)
      return next
    },
  }
}
