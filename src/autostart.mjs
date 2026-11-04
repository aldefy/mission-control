import { execFile } from "node:child_process"
import { existsSync, mkdirSync, readFileSync, realpathSync, unlinkSync, writeFileSync } from "node:fs"
import { homedir, tmpdir } from "node:os"
import { join, sep } from "node:path"

const xml = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
const launchctl = (args) => new Promise((done) => execFile("launchctl", args, { timeout: 10_000 }, (err) => done(!err)))
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

// What the dashboard reads from its environment, carried into the agent so launchd's copy reads the same data.
// MISSION_CONTROL_HOME is not among them: start at login is not offered under a stand-in home.
const CARRIED = ["CODEX_HOME", "MISSION_CONTROL_HOOKS_DIR", "MISSION_CONTROL_REMOTE_DIR"]
// Where a package manager keeps a node binary under a path that survives upgrades.
const STABLE_NODES = ["/opt/homebrew/bin/node", "/usr/local/bin/node"]

const real = (p) => { try { return realpathSync(p) } catch { return null } }

/**
 * Start-at-login for one dashboard as a macOS LaunchAgent, labelled by port, so the work and personal
 * dashboards each get their own. `argv` is the CLI's own arguments; the agent re-runs them with --no-open.
 * `run` (launchctl with an argument array, resolving true on success) and `nodes` are for tests.
 */
export function createAutostart({
  port, argv, script, cwd = process.cwd(), home = homedir(), platform = process.platform, env = process.env,
  execPath = process.execPath, run = launchctl, nodes = STABLE_NODES, retryMs = 1000,
}) {
  const label = `dev.mission-control.${port}`
  const plist = join(home, "Library", "LaunchAgents", `${label}.plist`)
  const log = join(home, ".mission-control", "logs", `${label}.log`)
  const managed = env.XPC_SERVICE_NAME === label
  const domain = `gui/${process.getuid?.() ?? 0}`
  // A script npx unpacked into its cache (or any temp dir) is gone once npm evicts it: the agent would fail at
  // every login. Start at login needs an installed copy.
  const scriptReal = real(script) ?? script
  const transient = [`${sep}_npx${sep}`, real(tmpdir()) ?? tmpdir()].some((p) => scriptReal.includes(p))
  const supported = platform === "darwin" && !transient
  const reason = platform !== "darwin" ? "start at login needs macOS"
    : transient ? "start at login needs an installed copy (npm i -g @aldefy/mission-control), not npx"
    : null

  // A node path that survives `brew upgrade` or an nvm switch when it is the same binary as this one.
  const node = () => nodes.find((n) => real(n) && real(n) === real(execPath)) ?? execPath

  function content() {
    const own = argv.filter((a) => a !== "--no-open")
    const hasPort = own.some((a) => a === "--port" || a.startsWith("--port="))
    const args = [node(), script, ...own, ...(hasPort ? [] : ["--port", String(port)]), "--no-open"]
    const vars = { PATH: env.PATH ?? "/usr/bin:/bin:/usr/sbin:/sbin", ...Object.fromEntries(CARRIED.filter((k) => env[k]).map((k) => [k, env[k]])) }
    return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${label}</string>
  <key>ProgramArguments</key>
  <array>
${args.map((a) => `    <string>${xml(a)}</string>`).join("\n")}
  </array>
  <key>WorkingDirectory</key><string>${xml(cwd)}</string>
  <key>EnvironmentVariables</key>
  <dict>
${Object.entries(vars).map(([k, v]) => `    <key>${xml(k)}</key><string>${xml(v)}</string>`).join("\n")}
  </dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key>
  <dict><key>SuccessfulExit</key><false/></dict>
  <key>StandardOutPath</key><string>${xml(log)}</string>
  <key>StandardErrorPath</key><string>${xml(log)}</string>
</dict>
</plist>
`
  }
  function write() {
    mkdirSync(join(home, "Library", "LaunchAgents"), { recursive: true })
    mkdirSync(join(home, ".mission-control", "logs"), { recursive: true, mode: 0o700 })
    writeFileSync(plist, content())
  }
  const remove = () => { try { unlinkSync(plist) } catch { /* already gone */ } }

  return {
    status: () => ({ supported, reason, enabled: supported && existsSync(plist), managed, label }),
    /**
     * On: write the agent, and when this process was started by hand, load it into launchd now, while this
     * process still holds the port. launchd's copy then waits for the port (see bin/mission-control.mjs), and
     * `restart` tells the caller to close its listeners and exit so the copy takes over. If launchd refuses the
     * job, the agent file is removed and this throws: the dashboard keeps running and the switch stays off.
     * Off: remove the agent so the next login does not start it; a running copy keeps running until logout
     * (booting it out from inside would stop the dashboard serving this very request).
     */
    async set(on) {
      if (!supported) throw { status: platform === "darwin" ? 409 : 501, message: reason }
      if (!on) { remove(); return { enabled: false, restart: false } }
      write()
      if (managed) return { enabled: true, restart: false }
      await run(["bootout", `${domain}/${label}`]) // a stale copy of the job from before; fine when absent
      // A job still being torn down makes bootstrap fail ("Input/output error"): try again once.
      const loaded = (await run(["bootstrap", domain, plist])) || (await sleep(retryMs), await run(["bootstrap", domain, plist]))
      if (!loaded) {
        remove()
        throw { status: 500, message: "launchctl did not load the agent; start at login stays off" }
      }
      return { enabled: true, restart: true }
    },
    /**
     * Running as the agent: rewrite the agent file when what it should say has changed (a stable node path
     * that now exists, the script, the carried variables), so the next login starts what runs now. True when
     * it was rewritten. Never creates the file: turning start at login on is the owner's call.
     */
    refresh() {
      if (!managed || !existsSync(plist)) return false
      const next = content()
      let now = null
      try { now = readFileSync(plist, "utf8") } catch { return false }
      if (now === next) return false
      writeFileSync(plist, next)
      return true
    },
    /** Undo a set(on) that went through, when another part of the same request failed. */
    async revert(on) {
      if (!on) return write() // turning it off only removed the file: put it back
      remove()
      if (!managed) await run(["bootout", `${domain}/${label}`])
    },
  }
}
