#!/usr/bin/env node
import { readFileSync, writeSync } from "node:fs"
import { fileURLToPath } from "node:url"

const argv = process.argv.slice(2)

// Hook entry points load only the hook modules: they run inside Claude Code / Codex and must stay fast,
// silent and harmless. Every path exits 0. Output is printed only for an accepted phone answer (v2.3).
if (argv[0] === "hook") {
  let output = ""
  let pending = null
  let remoteDir = null
  const cleanup = async () => {
    try { if (pending && remoteDir) (await import("../src/remote/prompts.mjs")).removePending(remoteDir, pending) } catch { /* best effort */ }
  }
  // Killed by the harness (timeout, or the prompt answered in the terminal): remove the pending prompt, print nothing.
  for (const sig of ["SIGTERM", "SIGINT", "SIGHUP"]) process.on(sig, () => { cleanup().finally(() => process.exit(0)) })
  try {
    const { recordHook, recordCodexHook, defaultHooksDir } = await import("../src/hooks.mjs")
    let raw = ""
    for (let i = 0; i < 5; i++) {
      try { raw = readFileSync(0, "utf8"); break } catch (e) {
        if (e?.code !== "EAGAIN") break // EAGAIN: stdin pipe not ready yet, try again shortly
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10)
      }
    }
    const hooksDir = process.env.MISSION_CONTROL_HOOKS_DIR || defaultHooksDir()
    const codex = argv[1] === "codex"
    // 1. record, as before v2.3
    if (codex) recordCodexHook({ raw, hooksDir }) // Codex names the event in its JSON
    else recordHook({ raw, event: argv[1], hooksDir })
    // 2–7. only the three answerable hook events may hold the request for a paired phone
    let input = null
    try { input = JSON.parse(raw) } catch { /* not JSON: nothing to wait for */ }
    const ev = input && typeof input === "object" ? (typeof input.hook_event_name === "string" ? input.hook_event_name : codex ? "" : argv[1]) : ""
    if (ev === "PermissionRequest" || (ev === "PreToolUse" && input.tool_name === "AskUserQuestion")) {
      const { remoteDirFromEnv } = await import("../src/remote/state.mjs")
      const { holdForAnswer } = await import("../src/remote/hook-wait.mjs")
      remoteDir = remoteDirFromEnv()
      output = await holdForAnswer({ harness: codex ? "codex" : "claude-code", input: { ...input, hook_event_name: ev }, hooksDir, remoteDir, onPending: (id) => { pending = id } })
    }
  } catch { /* never disturb the session */ }
  await cleanup()
  if (output) { try { writeSync(1, output) } catch { /* nothing to do */ } }
  process.exit(0)
}
if (argv[0] === "hooks" && argv[1] === "install") {
  const { settingsBlock, codexHooksBlock } = await import("../src/hooks.mjs")
  const { readWaitSeconds } = await import("../src/remote/state.mjs")
  const { homedir } = await import("node:os")
  const { join } = await import("node:path")
  const home = process.env.MISSION_CONTROL_HOME || homedir()
  const waitSeconds = readWaitSeconds(join(home, ".mission-control", "config.json"))
  const forCodex = argv[2] === "codex"
  const block = forCodex ? codexHooksBlock : settingsBlock // `hooks install codex`: the ~/.codex/hooks.json block
  console.log(JSON.stringify(block({ script: fileURLToPath(import.meta.url), waitSeconds }), null, 2))
  console.error(`mission control: v2.3 raised the ${forCodex ? "PermissionRequest" : "PermissionRequest and PreToolUse"} timeout to ${waitSeconds + 15}s (remote.waitSeconds ${waitSeconds} + 15) so a paired phone can answer. If you merged an older block, merge this one again.`)
  if (forCodex) console.error("mission control: Codex asks you to re-trust changed hooks: run /hooks in Codex and approve them.")
  process.exit(0)
}
if (argv[0] === "remote") {
  const { runRemote } = await import("../src/remote/cli.mjs")
  const { remoteDirFromEnv } = await import("../src/remote/state.mjs")
  const { defaultConfigPath } = await import("../src/hidden.mjs")
  const { homedir } = await import("node:os")
  const { join, resolve } = await import("node:path")
  const altHome = process.env.MISSION_CONTROL_HOME ? resolve(process.env.MISSION_CONTROL_HOME) : null
  const { spawnSync } = await import("node:child_process")
  // setup/doctor: shell out to tailscale, and ask before each change (y/N) when there is a terminal.
  const run = (cmd, a) => spawnSync(cmd, a, { encoding: "utf8", timeout: 30_000 })
  const ask = async (q) => {
    if (!process.stdin.isTTY) return false
    const { createInterface } = await import("node:readline/promises")
    const rl = createInterface({ input: process.stdin, output: process.stdout })
    try { return /^y(es)?$/i.test((await rl.question(q)).trim()) } finally { rl.close() }
  }
  const code = await runRemote({ args: argv.slice(1), remoteDir: remoteDirFromEnv(), home: altHome ?? homedir(), configPath: altHome ? join(altHome, ".mission-control", "config.json") : defaultConfigPath(), script: fileURLToPath(import.meta.url), run, ask })
  process.exit(code)
}

const { spawn } = await import("node:child_process")
const { createServer } = await import("../src/server.mjs")
const { defaultConfigPath } = await import("../src/hidden.mjs")
const { loadClaude, loadCodex, loadSources, parseArgs } = await import("../src/adapters/load.mjs")
let args
try { args = parseArgs(argv) } catch (e) {
  console.error(`mission control: ${e.message}`)
  process.exit(2)
}

const rawPort = args.port ?? process.env.MISSION_CONTROL_PORT ?? "4319"
const port = /^\d+$/.test(String(rawPort)) ? Number(rawPort) : NaN
if (!(port >= 0 && port <= 65535)) {
  console.error("mission control: --port needs a number")
  process.exit(2)
}

let adapters
try {
  adapters = await loadSources(argv, process.cwd())
  const claude = await loadClaude(argv, process.cwd())
  if (claude) adapters = [...adapters, claude]
  const codex = await loadCodex(argv, process.cwd())
  if (codex) adapters = [...adapters, codex]
} catch (e) {
  console.error(`mission control: ${e.message}`)
  process.exit(1)
}

let srv
const { homedir } = await import("node:os")
const { join: joinPath, resolve: resolvePath } = await import("node:path")
// MISSION_CONTROL_HOME: a stand-in home for config.json and the config readers (the demo uses a synthetic one).
const altHome = process.env.MISSION_CONTROL_HOME ? resolvePath(process.env.MISSION_CONTROL_HOME) : null
const home = altHome ?? homedir()
const codexHome = !altHome && process.env.CODEX_HOME ? resolvePath(process.env.CODEX_HOME) : joinPath(home, ".codex")
const { createPrReader } = await import("../src/prs.mjs")
// MISSION_CONTROL_DEMO_PRS: a JSON file standing in for `gh pr list` output (demo only).
const demoPrs = process.env.MISSION_CONTROL_DEMO_PRS
const prs = demoPrs ? createPrReader({ exec: async () => { try { return readFileSync(demoPrs, "utf8") } catch { return null } } }) : createPrReader()
const config = altHome ? joinPath(altHome, ".mission-control", "config.json") : defaultConfigPath()
// v2.3 remote answering: flags turn it on for this run (FR-2); otherwise config remote.enabled decides (C36).
const { checkRemoteFlags } = await import("../src/remote/cli.mjs")
const flagError = checkRemoteFlags({ remotePort: args["remote-port"], remoteHost: args["remote-host"], port })
if (flagError) {
  console.error(`mission control: ${flagError}`)
  process.exit(2)
}
const { remoteDirFromEnv } = await import("../src/remote/state.mjs")
const { defaultHooksDir } = await import("../src/hooks.mjs")
const remoteFlags = args["remote-port"] !== undefined ? { port: Number(args["remote-port"]), host: String(args["remote-host"]).toLowerCase() } : null
const remote = { home, remoteDir: remoteDirFromEnv(), hooksDir: process.env.MISSION_CONTROL_HOOKS_DIR || defaultHooksDir(home), flags: remoteFlags }
// The dashboard's own state (renames, pins and the like) sits next to config.json, under the same home.
const stateFile = (name) => joinPath(home, ".mission-control", name)
try { srv = await createServer(adapters, { port, config, claudeHome: home, codexHome, prs, remote, titlesPath: stateFile("titles.json"), marksPath: stateFile("marks.json"),
    settingsPath: stateFile("settings.json"), notifyLogPath: stateFile("logs/notifications.log"),
    // Notifications are sent only once switched on in the sidebar (or to a phone that turned push on).
    notifier: { mac: process.platform === "darwin" } }) } catch { process.exit(1) }
const started = await srv.remote.start()
if (!started.ok) {
  console.error(`mission control: remote answering stays off: ${started.error}`)
  if (remoteFlags) { await srv.close(); process.exit(2) }
}
// Clean shutdown: close the remote listener (waiting hooks fall back to the terminal) and remove server.json.
for (const sig of ["SIGINT", "SIGTERM"]) process.once(sig, () => { srv.remote.closeSync(); process.exit(0) })

if (!args.noOpen && process.platform === "darwin") {
  spawn("open", [`http://localhost:${srv.port}`], { stdio: "ignore", detached: true }).on("error", () => {}).unref()
}
