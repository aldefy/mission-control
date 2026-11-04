// node scripts/media/stage-demo.mjs [--port 4570]
// The demo, staged for release media (screenshots and the walkthrough video). On top of `npm run demo` it:
// - keeps the live session and the busy run growing (make-demo --live), so Live now has working lanes;
// - serves the sessions from a stand-in HOME's .claude/projects, so resume commands read
//   `cd /work/... && claude --resume ...` with no local path in them;
// - writes Claude Code process files (.claude/sessions/<pid>.json) for five sessions, pointing at placeholder
//   `sleep` processes, so open, closed, working and Ready come from the real reader;
// - adds a recap to "Search bar with suggestions";
// - clears the demo's saved renames and marks, so every take starts the same.
// Everything is synthetic and lives in examples/ (git-ignored) and a temp dir. Ctrl-C stops it all.
import { spawn } from "node:child_process"
import { appendFileSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..")
const argAfter = (n) => { const i = process.argv.indexOf(n); return i >= 0 ? process.argv[i + 1] : undefined }
const port = argAfter("--port") ?? "4570"
const ex = join(root, "examples")
const children = []
const stop = () => { for (const c of children) try { c.kill() } catch {} }
process.on("exit", stop)
for (const sig of ["SIGINT", "SIGTERM"]) process.on(sig, () => { stop(); process.exit(0) })

// 1. Generate the demo at the real "now" and keep the live parts growing.
const gen = spawn(process.execPath, [join(root, "scripts", "make-demo.mjs"), "--now", String(Date.now()), "--live"], { cwd: root, stdio: ["ignore", "pipe", "inherit"] })
children.push(gen)
await new Promise((ok, fail) => {
  gen.stdout.on("data", (d) => { process.stdout.write(d); if (String(d).includes("demo data in")) ok() })
  gen.on("exit", (code) => fail(new Error(`make-demo exited ${code}`)))
})

// 2. A stand-in home whose .claude/projects is the demo's sessions.
const home = mkdtempSync(join(tmpdir(), "mc-media-home-"))
const cfg = join(home, ".claude")
mkdirSync(join(cfg, "sessions"), { recursive: true })
symlinkSync(join(ex, "claude"), join(cfg, "projects"))
rmSync(join(ex, "demo-home", ".mission-control", "titles.json"), { force: true })
rmSync(join(ex, "demo-home", ".mission-control", "marks.json"), { force: true })

// 3. Open sessions: busy ones read as working, idle ones as Ready (or waiting, from the demo hooks).
const OPEN = { "sess-api-live": "busy", "sess-search-ui": "busy", "sess-shop-loop": "busy", "sess-api-waiting": "idle", "sess-app-flaky": "idle" }
for (const [sessionId, status] of Object.entries(OPEN)) {
  const p = spawn("sleep", ["86400"], { stdio: "ignore" })
  children.push(p)
  writeFileSync(join(cfg, "sessions", `${p.pid}.json`), JSON.stringify({ pid: p.pid, sessionId, status, kind: "interactive", statusUpdatedAt: Date.now() - 120_000 }))
}
appendFileSync(join(ex, "claude", "-work-shop-search", "sess-search-ui.jsonl"), JSON.stringify({
  type: "system", subtype: "away_summary", timestamp: new Date(Date.now() - 40 * 60_000).toISOString(),
  content: "You were adding keyboard navigation to the search suggestions; the arrow keys work and the ranking test passes. Next: highlight the matched text.",
}) + "\n")

// 4. Serve it. The remote state goes to the temp dir too, so a real dashboard's remote setup is never touched.
const server = spawn(process.execPath, [join(root, "bin", "mission-control.mjs"), "--claude-dir", join(cfg, "projects"), "--runs", "examples/runs", "--no-codex", "--port", port, "--no-open"], {
  cwd: root,
  stdio: "inherit",
  env: {
    ...process.env,
    HOME: home,
    MISSION_CONTROL_HOOKS_DIR: join(ex, "hooks"),
    MISSION_CONTROL_HOME: join(ex, "demo-home"),
    MISSION_CONTROL_DEMO_PRS: join(ex, "demo-prs.json"),
    MISSION_CONTROL_REMOTE_DIR: join(home, "remote"),
  },
})
children.push(server)
server.on("exit", (code) => { stop(); process.exit(code ?? 0) })
console.log(`staged demo on http://localhost:${port}/ (Ctrl-C to stop)`)
