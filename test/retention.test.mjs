import { test } from "node:test"
import assert from "node:assert/strict"
import { chmodSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, symlinkSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createRetention } from "../src/retention.mjs"

test("retention: reads and sets only cleanupPeriodDays; never overwrites a broken settings.json", () => {
  const dir = mkdtempSync(join(tmpdir(), "mc-ret-"))
  const r = createRetention(dir)
  assert.deepEqual([r.get().days, r.get().isDefault], [30, true]) // no settings.json: Claude Code's default
  writeFileSync(join(dir, "settings.json"), JSON.stringify({ hooks: { Stop: [] }, model: "opus" }))
  assert.equal(r.set(365).days, 365)
  assert.deepEqual(JSON.parse(readFileSync(join(dir, "settings.json"), "utf8")), { hooks: { Stop: [] }, model: "opus", cleanupPeriodDays: 365 })
  assert.throws(() => r.set(0), (e) => e.status === 400)
  writeFileSync(join(dir, "settings.json"), "{ broken")
  assert.throws(() => r.set(90), (e) => e.status === 409)
  assert.equal(readFileSync(join(dir, "settings.json"), "utf8"), "{ broken")
})

test("settings route: a request is applied whole or not at all (retention is not written when start at login cannot run)", async () => {
  const { createServer } = await import("../src/server.mjs")
  const cfg = mkdtempSync(join(tmpdir(), "mc-ret-"))
  writeFileSync(join(cfg, "settings.json"), JSON.stringify({ model: "opus" }))
  const dist = mkdtempSync(join(tmpdir(), "mc-dist-"))
  writeFileSync(join(dist, "index.html"), "ok")
  const src = { name: "claude-code", harness: "claude-code", describe: () => ({ source: join(cfg, "projects") }), listItems: async () => [], getItem: async () => null, getCalls: async () => [], getSession: async () => null }
  const srv = await createServer(src, { port: 0, distDir: dist }) // no autostart: start at login unsupported
  const post = (body) => fetch(`http://127.0.0.1:${srv.port}/api/settings`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) })
  try {
    assert.equal((await post({ retentionDays: 90, autostart: true })).status, 501)
    assert.deepEqual(JSON.parse(readFileSync(join(cfg, "settings.json"), "utf8")), { model: "opus" })
    assert.equal((await post({ retentionDays: 90 })).status, 200)
    assert.equal(JSON.parse(readFileSync(join(cfg, "settings.json"), "utf8")).cleanupPeriodDays, 90)
  } finally { await srv.close() }
})

test("retention: a symlinked settings.json is written where it points (the link stays), and no temp file is left", () => {
  const dir = mkdtempSync(join(tmpdir(), "mc-ret-"))
  const dots = join(dir, "dotfiles")
  mkdirSync(dots)
  writeFileSync(join(dots, "claude-settings.json"), JSON.stringify({ model: "opus" }))
  const cfg = join(dir, "cfg")
  mkdirSync(cfg)
  symlinkSync(join(dots, "claude-settings.json"), join(cfg, "settings.json"))
  createRetention(cfg).set(60)
  assert.ok(lstatSync(join(cfg, "settings.json")).isSymbolicLink())
  assert.equal(JSON.parse(readFileSync(join(dots, "claude-settings.json"), "utf8")).cleanupPeriodDays, 60)
  assert.deepEqual(readdirSync(dots), ["claude-settings.json"])
})

test("settings route: start at login is put back when writing Claude Code's settings.json then fails", { skip: process.getuid?.() === 0 }, async () => {
  const { createServer } = await import("../src/server.mjs")
  const cfg = mkdtempSync(join(tmpdir(), "mc-ret-"))
  writeFileSync(join(cfg, "settings.json"), JSON.stringify({ model: "opus" }))
  const dist = mkdtempSync(join(tmpdir(), "mc-dist-"))
  writeFileSync(join(dist, "index.html"), "ok")
  const log = []
  const autostart = { status: () => ({ supported: true, enabled: false, managed: true, label: "x" }), set: async (on) => (log.push(`set ${on}`), { enabled: on, restart: false }), revert: async (on) => log.push(`revert ${on}`) }
  const src = { name: "claude-code", harness: "claude-code", describe: () => ({ source: join(cfg, "projects") }), listItems: async () => [], getItem: async () => null, getCalls: async () => [], getSession: async () => null }
  const srv = await createServer(src, { port: 0, distDir: dist, autostart })
  chmodSync(cfg, 0o500) // the temp file cannot be created: the write fails after start at login went through
  try {
    const r = await fetch(`http://127.0.0.1:${srv.port}/api/settings`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ autostart: true, retentionDays: 90 }) })
    assert.equal(r.status, 500)
    assert.deepEqual(log, ["set true", "revert true"])
  } finally { chmodSync(cfg, 0o700); await srv.close() }
})
