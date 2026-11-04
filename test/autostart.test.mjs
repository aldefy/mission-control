import { test } from "node:test"
import assert from "node:assert/strict"
import { existsSync, mkdtempSync, readFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createAutostart } from "../src/autostart.mjs"

test("autostart: a per-port LaunchAgent re-running the CLI args with --port and --no-open; off removes it", async () => {
  const home = mkdtempSync(join(tmpdir(), "mc-home-"))
  const label = "dev.mission-control.4359"
  // Running as that agent already: set(true) only rewrites the plist, no launchctl.
  const a = createAutostart({ port: 4359, argv: ["--claude-dir", "/x y/projects"], script: "/mc/bin/mission-control.mjs", home, platform: "darwin", env: { XPC_SERVICE_NAME: label, PATH: "/bin" } })
  assert.deepEqual(await a.set(true), { enabled: true, restart: false })
  const plist = join(home, "Library", "LaunchAgents", `${label}.plist`)
  const text = readFileSync(plist, "utf8")
  for (const s of ["/mc/bin/mission-control.mjs", "<string>--claude-dir</string>", "<string>/x y/projects</string>", "<string>--port</string>", "<string>4359</string>", "<string>--no-open</string>", "<key>SuccessfulExit</key><false/>"]) assert.ok(text.includes(s), s)
  assert.equal(a.status().enabled, true)
  await a.set(false)
  assert.equal(existsSync(plist), false)
  await assert.rejects(createAutostart({ port: 1, argv: [], script: "s", home, platform: "linux" }).set(true))
  // Started by hand: set(true) loads the agent while this process still holds the port, then asks for the hand-over.
  const calls = []
  const byHand = createAutostart({ port: 4360, argv: [], script: "/mc/bin/mission-control.mjs", home, platform: "darwin", env: { PATH: "/bin" }, run: async (a) => (calls.push(a[0]), true) })
  assert.deepEqual(await byHand.set(true), { enabled: true, restart: true })
  assert.deepEqual(calls, ["bootout", "bootstrap"])
})

test("autostart: launchctl refusing the agent (twice) removes it and throws; nothing is handed over", async () => {
  const home = mkdtempSync(join(tmpdir(), "mc-home-"))
  const calls = []
  const a = createAutostart({ port: 4361, argv: [], script: "/mc/bin/mission-control.mjs", home, platform: "darwin", env: { PATH: "/bin" }, retryMs: 0,
    run: async (args) => (calls.push(args[0]), args[0] !== "bootstrap") })
  await assert.rejects(a.set(true), (e) => e.status === 500)
  assert.deepEqual(calls, ["bootout", "bootstrap", "bootstrap"])
  assert.equal(a.status().enabled, false)
  assert.equal(existsSync(join(home, "Library", "LaunchAgents", "dev.mission-control.4361.plist")), false)
})

test("autostart: not offered for an npx copy; carries the env the dashboard reads; --port=N counts as a port", async () => {
  const home = mkdtempSync(join(tmpdir(), "mc-home-"))
  const npx = createAutostart({ port: 4362, argv: [], script: "/Users/u/.npm/_npx/abc/node_modules/@aldefy/mission-control/bin/mission-control.mjs", home, platform: "darwin", env: {} })
  assert.equal(npx.status().supported, false)
  assert.match(npx.status().reason, /installed copy/)
  await assert.rejects(npx.set(true), (e) => e.status === 409)
  const label = "dev.mission-control.4363"
  const a = createAutostart({ port: 4363, argv: ["--port=4363"], script: "/mc/bin/mission-control.mjs", home, platform: "darwin",
    env: { XPC_SERVICE_NAME: label, PATH: "/bin", CODEX_HOME: "/x/codex", MISSION_CONTROL_HOOKS_DIR: "/x/hooks", SECRET: "no" } })
  await a.set(true)
  const text = readFileSync(join(home, "Library", "LaunchAgents", `${label}.plist`), "utf8")
  for (const s of ["<key>CODEX_HOME</key><string>/x/codex</string>", "<key>MISSION_CONTROL_HOOKS_DIR</key><string>/x/hooks</string>", "<string>--port=4363</string>"]) assert.ok(text.includes(s), s)
  assert.ok(!text.includes("SECRET"))
  assert.equal(text.split("<string>--port</string>").length, 1) // no second --port
})

test("autostart refresh: run as the agent, a changed node path or script rewrites the agent file; unchanged or not the agent does nothing", async () => {
  const home = mkdtempSync(join(tmpdir(), "mc-home-"))
  const label = "dev.mission-control.4370"
  const make = (execPath, env) => createAutostart({ port: 4370, argv: [], script: "/mc/bin/mission-control.mjs", home, platform: "darwin", env: { PATH: "/bin", ...env }, execPath, nodes: [], run: async () => true })
  const plist = join(home, "Library", "LaunchAgents", `${label}.plist`)
  assert.equal(make("/old/node", { XPC_SERVICE_NAME: label }).refresh(), false) // no agent file: never created here
  await make("/old/node", { XPC_SERVICE_NAME: label }).set(true)
  assert.ok(readFileSync(plist, "utf8").includes("<string>/old/node</string>"))
  assert.equal(make("/old/node", { XPC_SERVICE_NAME: label }).refresh(), false)
  assert.equal(make("/new/node", {}).refresh(), false) // started by hand: not the agent, leaves it alone
  assert.equal(make("/new/node", { XPC_SERVICE_NAME: label }).refresh(), true)
  assert.ok(readFileSync(plist, "utf8").includes("<string>/new/node</string>"))
})
