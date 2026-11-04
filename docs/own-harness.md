# Use Mission Control with your own harness

A harness is whatever runs your agents: a script that calls a model in a loop, a pipeline of stages, a crew of agents passing work around. This guide shows how to make yours appear in Mission Control next to Claude Code and Codex sessions, with lanes, a timeline, costs and a Needs you queue.

There are two ways in. Pick the first unless it cannot say what you need.

| | Level 2: the run format | Level 3: an adapter |
|---|---|---|
| what you write | two files per run, from any language | a JS module the dashboard loads |
| what you get | runs with stages as lanes, calls, timeline, crew map, tokens and cost, waiting on you | all of that, or your own items, lanes and calls, plus extra tabs and action buttons (Sign, Answer) |
| code inside the dashboard | none | yours |

The full reference for the run format is [FORMAT.md](../FORMAT.md). This page walks through it.

## Level 2: write runs

### 1. Lay out a runs directory

Pick one directory for all runs, for example `/work/runs`. Each run gets a folder named by its id:

```
/work/runs/
  20261102-0900-tips/
    state.json        what the run is and where each stage stands (rewritten as it changes)
    runs.jsonl        what happened, one event per line (only ever appended)
    sessions/         optional transcripts, linked from events
      plan-1.md
```

A run id matches `^[\w-]+$` (letters, digits, `_` and `-`). Starting it with the date and time keeps runs sorted.

### 2. Write state.json

Minimum: an id, a one-line title (`idea`) and the stages in display order.

```json
{
  "runId": "20261102-0900-tips",
  "idea": "add a tip calculator page",
  "harness": "my-harness",
  "repo": "/work/tips",
  "branch": "feat/tip-calculator",
  "stages": {
    "plan": { "status": "done", "rounds": 1 },
    "build": { "status": "done", "rounds": 2 },
    "review": { "status": "done", "rounds": 1 }
  }
}
```

- `stages` statuses: `pending`, `running`, `done`, `skipped`, `stopped`, `failed`, `blocked`. Update them as stages move.
- `harness` is the name shown in the header and on usage charts.
- `repo` groups the run under a project (by its last path part) and `branch` under a worktree.
- `graph` (optional) draws your own crew layout; see [FORMAT.md](../FORMAT.md#graph-optional).

Write the file in one step (write a temporary file, then rename it over `state.json`) so the dashboard never reads half of it.

### 3. Append events to runs.jsonl

Every line is one JSON object with `type` and `ts` (an ISO time). The core events:

| type | fields | what it drives |
|---|---|---|
| `run.start`, `run.end`, `run.resume` | | the run's span, Live or Ended |
| `stage.start` | `stage`, `attempt?` | a lane starts; a bar opens on the timeline |
| `stage.end` | `stage`, `ok`, `reason?`, `durationMs?` | the bar closes; `ok: false` marks a failure |
| `stage.skipped` | `stage`, `reason` | a skipped stage |
| `session` | `stage`, `model`, `tokens`, `cost`, `transcript?` | one LLM call or conversation: tokens, cost, and a transcript link |
| `progress` | `stage`, `tool`, `detail?` | a tool call tick (shown on Calls and the timeline) |
| `issue` | `stage`, `summary`, `decision?` | an error; with `decision.owner` it draws a send-back edge |
| `stop` | `stage?`, `rule`, `detail` | `rule: "human"` means waiting on you; any other rule shows as Stopped |
| `human.input` | `stage?`, `text` | you answered; clears the stop |

`tokens` uses Anthropic's names: `{ "input_tokens", "output_tokens", "cache_creation_input_tokens", "cache_read_input_tokens" }`. `cost` is in dollars, computed by your harness (the dashboard shows it as an estimate). Events the table does not list are kept and ignored, so you can add your own.

### 4. A complete worked example

This run plans, builds (the first attempt fails its tests and is sent back), and then waits for a human before shipping.

`/work/runs/20261102-0900-tips/runs.jsonl`:

```jsonl
{"ts":"2026-11-02T09:00:00Z","type":"run.start"}
{"ts":"2026-11-02T09:00:05Z","type":"stage.start","stage":"plan"}
{"ts":"2026-11-02T09:03:00Z","type":"session","stage":"plan","model":"claude-sonnet-4-5","cost":0.05,"tokens":{"input_tokens":4000,"output_tokens":900,"cache_creation_input_tokens":0,"cache_read_input_tokens":12000},"transcript":"plan-1.md"}
{"ts":"2026-11-02T09:03:10Z","type":"stage.end","stage":"plan","ok":true,"durationMs":185000}
{"ts":"2026-11-02T09:03:15Z","type":"stage.start","stage":"build"}
{"ts":"2026-11-02T09:04:00Z","type":"progress","stage":"build","tool":"Write","detail":"src/tips.ts"}
{"ts":"2026-11-02T09:06:00Z","type":"progress","stage":"build","tool":"Bash","detail":"npm test"}
{"ts":"2026-11-02T09:06:30Z","type":"issue","stage":"build","summary":"2 tests fail: rounding of 12.5%","decision":{"owner":"build","blocks":true}}
{"ts":"2026-11-02T09:06:40Z","type":"stage.end","stage":"build","ok":false,"reason":"tests failing"}
{"ts":"2026-11-02T09:06:45Z","type":"stage.start","stage":"build","attempt":2}
{"ts":"2026-11-02T09:09:00Z","type":"progress","stage":"build","tool":"Edit","detail":"round to cents"}
{"ts":"2026-11-02T09:10:00Z","type":"session","stage":"build","model":"claude-sonnet-4-5","cost":0.21,"tokens":{"input_tokens":9000,"output_tokens":2600,"cache_creation_input_tokens":1500,"cache_read_input_tokens":40000}}
{"ts":"2026-11-02T09:10:05Z","type":"stage.end","stage":"build","ok":true}
{"ts":"2026-11-02T09:10:10Z","type":"stage.start","stage":"review"}
{"ts":"2026-11-02T09:12:00Z","type":"stop","stage":"review","rule":"human","detail":"Ship with tips capped at 30%?"}
{"ts":"2026-11-02T09:20:00Z","type":"human.input","stage":"review","text":"yes, cap at 30%"}
{"ts":"2026-11-02T09:21:00Z","type":"stage.end","stage":"review","ok":true}
{"ts":"2026-11-02T09:21:05Z","type":"run.end","ok":true}
```

`/work/runs/20261102-0900-tips/sessions/plan-1.md` is any Markdown; the `session` event links it by name.

What the dashboard shows for it:

- three lanes, `plan`, `build` and `review`, all done; `build` has 3 calls and 1 error;
- a timeline with the failed first build attempt and the retry;
- tokens 13,000 in, 3,500 out, 52,000 cache read, 1,500 cache write, and $0.26 est.;
- the plan transcript on the plan lane.

Cut the file after the `stop` line and the run is **waiting on you**: the home page lists it under Needs you with "Ship with tips capped at 30%?". The rule: a run waits when its last `stop` has `rule: "human"` and no `stage.start`, `human.input`, `run.resume` or `run.start` came after it.

A run is **Live** while there is no `run.end` after the last `run.start` and some event is less than 10 minutes old (or while a `run.lock` file in the run folder holds the pid of a running process).

### 5. Writers in Node, Python and Bash

Use whichever your harness is written in. Each appends whole lines, so the dashboard can read while you write.

Node:

```js
// emit.mjs
import { appendFileSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs"
import { join } from "node:path"

export function startRun(runsDir, runId, state) {
  const dir = join(runsDir, runId)
  mkdirSync(join(dir, "sessions"), { recursive: true })
  writeState(dir, { runId, ...state })
  emit(dir, { type: "run.start" })
  return dir
}

/** Replace state.json in one step, so a reader never sees half a file. */
export function writeState(dir, state) {
  writeFileSync(join(dir, "state.json.tmp"), JSON.stringify(state, null, 2))
  renameSync(join(dir, "state.json.tmp"), join(dir, "state.json"))
}

/** Set one stage's status in state.json. */
export function setStage(dir, stage, status) {
  const s = JSON.parse(readFileSync(join(dir, "state.json"), "utf8"))
  s.stages[stage] = { ...s.stages[stage], status }
  writeState(dir, s)
}

/** Append one event to runs.jsonl: one JSON object, one line, with a time. */
export function emit(dir, event) {
  appendFileSync(join(dir, "runs.jsonl"), JSON.stringify({ ts: new Date().toISOString(), ...event }) + "\n")
}
```

```js
import { startRun, emit, setStage } from "./emit.mjs"

const dir = startRun("/work/runs", "20261102-1400-tips", {
  idea: "add a tip calculator", harness: "my-harness", repo: "/work/tips", branch: "feat/tips",
  stages: { plan: { status: "pending" }, build: { status: "pending" } },
})
setStage(dir, "plan", "running")
emit(dir, { type: "stage.start", stage: "plan" })
emit(dir, { type: "session", stage: "plan", model: "claude-sonnet-4-5", cost: 0.03, tokens: { input_tokens: 1200, output_tokens: 300 } })
emit(dir, { type: "stage.end", stage: "plan", ok: true })
setStage(dir, "plan", "done")
emit(dir, { type: "stop", stage: "build", rule: "human", detail: "Approve the plan before building?" })
```

Python:

```python
# emit.py
import json, os
from datetime import datetime, timezone

def now():
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%S.%f")[:-3] + "Z"

def write_state(run_dir, state):
    tmp = os.path.join(run_dir, "state.json.tmp")
    with open(tmp, "w") as f:
        json.dump(state, f, indent=2)
    os.replace(tmp, os.path.join(run_dir, "state.json"))  # one step: never half a file

def emit(run_dir, event):
    with open(os.path.join(run_dir, "runs.jsonl"), "a") as f:
        f.write(json.dumps({"ts": now(), **event}) + "\n")

run_dir = "/work/runs/20261102-1500-login"
os.makedirs(os.path.join(run_dir, "sessions"), exist_ok=True)
write_state(run_dir, {"runId": "20261102-1500-login", "idea": "fix the login redirect",
                      "harness": "my-harness", "repo": "/work/app",
                      "stages": {"fix": {"status": "running"}}})
emit(run_dir, {"type": "run.start"})
emit(run_dir, {"type": "stage.start", "stage": "fix"})
emit(run_dir, {"type": "progress", "stage": "fix", "tool": "Edit", "detail": "src/login.ts"})
```

Bash (no `jq` needed; pass the fields as JSON text):

```bash
#!/usr/bin/env bash
# emit.sh: append one event to a run's runs.jsonl.  Usage: emit.sh <run-dir> '<json fields>'
set -euo pipefail
run_dir=$1; fields=$2
ts=$(date -u +%Y-%m-%dT%H:%M:%SZ)
printf '{"ts":"%s",%s}\n' "$ts" "$fields" >> "$run_dir/runs.jsonl"
```

```bash
run=/work/runs/20261102-1600-lint
mkdir -p "$run"
printf '%s\n' '{"runId":"20261102-1600-lint","idea":"lint the repo","harness":"my-harness","repo":"/work/app","stages":{"lint":{"status":"done"}}}' > "$run/state.json"
./emit.sh "$run" '"type":"run.start"'
./emit.sh "$run" '"type":"stage.start","stage":"lint"'
./emit.sh "$run" '"type":"progress","stage":"lint","tool":"Bash","detail":"npm run lint"'
./emit.sh "$run" '"type":"stage.end","stage":"lint","ok":true'
./emit.sh "$run" '"type":"run.end","ok":true'
```

### 6. Point the dashboard at it

```bash
node bin/mission-control.mjs --runs /work/runs
```

Claude Code and Codex sessions stay on next to your runs; add `--no-claude --no-codex` to see only runs. Mission Control never writes to the runs directory.

## Level 3: write an adapter

Write an adapter when the run format is not enough: your harness keeps state somewhere else (a database, an API, its own files), you want buttons that talk back to it, or extra tabs. An adapter is an ES module whose default export is `create(options)`.

```bash
node bin/mission-control.mjs --adapter /work/my-adapter.mjs                             # load it
node bin/mission-control.mjs --adapter /work/my-adapter.mjs --runs /work/runs           # runsDir passed to it
node bin/mission-control.mjs --adapter /work/my-adapter.mjs --adapter-opt dir=/work/jobs --adapter-opt team=web
```

`create` is called with `{ ...adapterOpts, runsDir, createNative }`: every `--adapter-opt k=v` as a string option, `runsDir` (from `--runs`, default `./runs`), and `createNative`, the built-in runs-directory reader, so you can wrap it.

`create` returns one of two shapes.

### A v1 adapter: runs

The dashboard wraps it for you (stages become lanes, events become calls), exactly like a runs directory.

```js
{
  name: "my-harness",
  describe?(): { source?: string },             // shown on the empty home page
  listRuns(): Promise<RunSummary[]>,            // newest first
  getRun(id): Promise<{ state, events, live } | null>,   // state.json and runs.jsonl as objects
  getSession(id, name): Promise<{ text, truncated? } | null>,
  extras?: { [key]: (id | null, query: URLSearchParams) => Promise<{ status?, type?, body }> },
  actions?: { [key]: (id, body) => Promise<object> },   // throw { status, message } to refuse
}
```

`RunSummary` is `{ id, idea, repo?, live, waiting?, stages: { [stage]: { status, rounds? } }, harness? }`. Compute `waiting` with `isWaiting(events)` from `src/status.mjs`.

### A v2 source: your own items

Anything with `listItems` is used as is. The types are in `src/sources/types.mjs`.

```js
{
  name: "jobs",
  harness: "jobs",
  listItems(): Promise<ItemSummary[]>,          // { source, id, kind: "run" | "session", title, harness, cwd, branch, live, status, waiting, startedAt, updatedAt, counts, tokens, cost }
  getItem(id): Promise<{ summary, lanes, events, state? } | null>,   // Lane: { id, label, kind, status, model?, nowDoing?, calls, errors, tokens, cost, parent? }
  getCalls(id, { lane?, kind?, q? }): Promise<Call[]>,               // Call: { id, lane, ts, name, kind: "tool" | "mcp" | "skill" | "agent", summary, ok?, error?, durationMs? }
  getSession(id, name): Promise<{ text, truncated? } | null>,
  getTurns?(id, lane, { before?, limit? }),     // Chat tab pages: { lane, total, start, turns }
  usage?({ from?, to?, tz? }): Promise<UsageRow[]>,
  extras?, actions?, ui?, describe?(),               // served under /api/item/<source>/<id>/x/<key> and /action/<name>
}
```

`status` is one of `working`, `waiting` (needs you), `stopped`, `failed`, `done`, `idle`. `tokens` is `{ in, out, cacheRead, cacheWrite }`.

### A complete v2 source

Each `/work/jobs/<id>.json` file is one session; its calls name their lane.

```json
{ "title": "nightly dependency bump", "cwd": "/work/app", "branch": "main", "status": "waiting",
  "calls": [
    { "lane": "main", "ts": "2026-11-02T10:00:00Z", "name": "Bash", "summary": "npm outdated", "ok": true },
    { "lane": "checker", "ts": "2026-11-02T10:01:00Z", "name": "Bash", "summary": "npm test", "ok": false }
  ] }
```

```js
// jobs-source.mjs: a complete v2 source. Each /work/jobs/<id>.json is one session with lanes and calls:
// { "title": "...", "cwd": "/work/app", "branch": "main", "status": "working",
//   "calls": [{ "lane": "main", "ts": "2026-11-02T10:00:00Z", "name": "Bash", "summary": "npm test", "ok": true }] }
// Start:  node bin/mission-control.mjs --adapter /work/jobs-source.mjs --adapter-opt dir=/work/jobs
import { readFileSync, readdirSync } from "node:fs"
import { join, resolve } from "node:path"

const zero = () => ({ in: 0, out: 0, cacheRead: 0, cacheWrite: 0 })

export default function create({ dir = "jobs" }) {
  const root = resolve(dir)
  const read = (id) => {
    if (!/^[\w-]+$/.test(id)) return null // ids are file names: no paths
    try { return JSON.parse(readFileSync(join(root, `${id}.json`), "utf8")) } catch { return null }
  }
  const summary = (id, j) => {
    const calls = j.calls ?? []
    const stamps = calls.map((c) => c.ts).sort()
    return {
      source: "jobs", id, kind: "session", title: j.title ?? id, harness: "jobs",
      cwd: j.cwd ?? null, branch: j.branch ?? null,
      live: j.status === "working", status: j.status ?? "idle", waiting: j.status === "waiting",
      startedAt: stamps[0] ?? null, updatedAt: stamps.at(-1) ?? null,
      counts: { lanes: new Set(calls.map((c) => c.lane ?? "main")).size || 1, calls: calls.length, errors: calls.filter((c) => c.ok === false).length },
      tokens: zero(), cost: 0,
    }
  }
  const callsOf = (j) => (j.calls ?? []).map((c, i) => ({ id: `c${i}`, lane: c.lane ?? "main", ts: c.ts, name: c.name, kind: c.kind ?? "tool", summary: c.summary ?? c.name, ok: c.ok }))
  return {
    name: "jobs",
    harness: "jobs",
    describe: () => ({ source: root }),
    async listItems() {
      let files = []
      try { files = readdirSync(root).filter((f) => f.endsWith(".json")) } catch { return [] }
      return files.map((f) => f.slice(0, -5)).map((id) => [id, read(id)]).filter(([, j]) => j).map(([id, j]) => summary(id, j))
    },
    async getItem(id) {
      const j = read(id)
      if (!j) return null
      const calls = callsOf(j)
      const lanes = [...new Set(["main", ...calls.map((c) => c.lane)])].map((lane) => {
        const mine = calls.filter((c) => c.lane === lane)
        return {
          id: lane, label: lane, kind: lane === "main" ? "main" : "subagent", ...(lane === "main" ? {} : { parent: "main" }),
          status: lane === "main" ? (j.status ?? "idle") : "done",
          calls: mine.length, errors: mine.filter((c) => c.ok === false).length, tokens: zero(), cost: 0,
        }
      })
      return { summary: summary(id, j), lanes, events: [] }
    },
    async getCalls(id, { lane, kind, q } = {}) {
      const j = read(id)
      return j ? callsOf(j).filter((c) => (!lane || c.lane === lane) && (!kind || c.kind === kind) && (!q || c.summary.toLowerCase().includes(String(q).toLowerCase()))) : []
    },
    async getSession() { return null }, // no transcripts
  }
}
```

```bash
node bin/mission-control.mjs --adapter /work/jobs-source.mjs --adapter-opt dir=/work/jobs
```

The job shows under the `app` project, waiting on you, with two lanes (`main` and `checker`) and one failed call.

## Actions: Sign and Answer (optional)

When an item is waiting, the Needs you card shows buttons for the actions your adapter declares, and only those:

| action | button | body your function gets |
|---|---|---|
| `sign` | **Sign** (approve) and **Send back** with notes | `{ notes }`: empty to approve, text to send back |
| `say` | an answer box (`@stage text` picks the stage) | `{ stage, text }` |

They are served at `POST /api/item/<source>/<id>/action/<name>` (and `/api/run/<id>/action/<name>` for the first v1 adapter). Return any object; throw `{ status, message }` to refuse, and the page shows the message. The server only accepts these posts from its own page (JSON body, local origin).

This v1 adapter reads a runs directory with the built-in reader and answers the harness by appending a `human.input` line to the run's own `runs.jsonl`, which is how this harness hears replies:

```js
// my-harness-adapter.mjs: runs from a runs directory, plus Sign and Answer buttons.
// Start:  node bin/mission-control.mjs --adapter /work/my-harness-adapter.mjs --runs /work/runs
import { appendFileSync, existsSync } from "node:fs"
import { join } from "node:path"

export default function create({ runsDir, createNative }) {
  const native = createNative({ runsDir }) // the built-in reader: listRuns, getRun, getSession
  const runDir = (id) => {
    const dir = join(runsDir, id)
    if (!/^[\w-]+$/.test(id) || !existsSync(join(dir, "state.json"))) throw { status: 404, message: "no such run" }
    return dir
  }
  // The harness reads its own runs.jsonl: a human.input line is how it hears your answer.
  const reply = (id, event) => {
    appendFileSync(join(runDir(id), "runs.jsonl"), JSON.stringify({ ts: new Date().toISOString(), type: "human.input", ...event }) + "\n")
    return { ok: true }
  }
  return {
    ...native,
    name: "my-harness",
    actions: {
      // Sign: body { notes }. Empty notes approve; notes send the stage back with them.
      async sign(id, { notes = "" }) {
        if (typeof notes !== "string") throw { status: 400, message: "notes must be text" }
        return reply(id, { text: notes ? `send back: ${notes}` : "approved", decision: notes ? "send-back" : "approve" })
      },
      // Say: body { stage, text }. A free answer to one stage.
      async say(id, { stage, text }) {
        if (typeof text !== "string" || !text.trim()) throw { status: 400, message: "text is required" }
        return reply(id, { stage: typeof stage === "string" ? stage : undefined, text: text.trim() })
      },
    },
  }
}
```

```bash
node bin/mission-control.mjs --adapter /work/my-harness-adapter.mjs --runs /work/runs
```

Mission Control's own sources never write; an adapter decides for itself what its actions do. Keep them narrow: check the id, accept only the fields you expect.

## Your own tabs on the page (pane plugins, v2.6)

An adapter can ship UI of its own. Set `ui` to the absolute path of one ES module. The page loads it from `/ui/<source>/page.js` and calls its default export with a host:

```js
// my-harness/ui.mjs: runs in the browser, so no node: imports
export default function register(host) {
  host.tabs.register({
    id: "reports",            // lowercase, a-z 0-9 _ -
    label: "Reports",
    kinds: ["run"],           // optional: only on these item kinds
    mount(el, ctx) {          // el: an empty element; ctx: { source, id, item, action(name, body), extra(name, params) }
      el.textContent = `${ctx.item.events.length} events`
      return { update(next) { el.textContent = `${next.item.events.length} events` }, unmount() {} }
    },
  })
}
```

```js
// the adapter
export default function create() {
  return { name: "my-harness", listRuns, getRun, getSession, ui: new URL("./ui.mjs", import.meta.url).pathname }
}
```

- The tab appears after the built-in ones on every item from that source. `update` runs whenever the item changes, which is pushed live, so a pane stays current without its own polling.
- Draw with the DOM and style with the page's CSS variables (`var(--border)`, `var(--muted-foreground)`, `var(--looping)`, and so on), so it follows the theme. Put text in with `textContent` or `append`, never `innerHTML`, because run data comes from agents.
- `ctx.action` calls your adapter's actions, and `ctx.extra` builds the URL of one of your extras.
- Only that one file is served, and only when the path is absolute and ends in `.js` or `.mjs`. It is your adapter's code, which already runs in the dashboard process. A module that fails to load adds no tabs and logs a warning.

Ronin uses this for its Reports tab (`lib/dashboard-adapter/ronin-ui.mjs`), which shows each stage's checked report.

## Test it with the demo

1. Look at a working harness first:

   ```bash
   npm run demo
   ```

   It serves invented runs and sessions on `http://localhost:4320`. `examples/runs/20261101-0900-greeter` is a small tracked run you can copy as a starting point.

2. Run your own output on its own port, without your real sessions:

   ```bash
   node bin/mission-control.mjs --runs /work/runs --no-claude --no-codex --port 4400
   ```

3. Check what the dashboard parsed, without the page:

   ```bash
   curl -s http://localhost:4400/api/sources                        # your source, and an "error" if listing failed
   curl -s http://localhost:4400/api/items                          # every run or item with status and counts
   curl -s http://localhost:4400/api/item/native/20261102-0900-tips # lanes, events, totals of one run
   ```

   With an adapter, the source name in the URL is your adapter's `name` instead of `native`.

4. Append events while the page is open; it polls and updates on its own.

## Checklist

- [ ] Run ids match `^[\w-]+$`, and each run folder has `state.json`.
- [ ] `state.json` has `idea` and `stages` in display order, plus `harness` and `repo` so the run lands under a project.
- [ ] `state.json` is replaced in one step (temp file, then rename); `runs.jsonl` is only appended, one whole JSON object per line.
- [ ] Every event has `type` and an ISO `ts`.
- [ ] Each stage has a `stage.start` and a `stage.end` with `ok`; failures say why in `reason`.
- [ ] LLM calls are `session` events with `model`, `tokens` and `cost`.
- [ ] A question for a human is a `stop` with `rule: "human"` and a `detail` that reads well on its own; the answer is a `human.input`.
- [ ] The run ends with `run.end`, or has a `run.lock` while it runs.
- [ ] `transcript` values are bare file names in `sessions/` ending in `.md` or `.jsonl`.
- [ ] An adapter returns `null` for unknown ids, never throws from `listRuns`/`listItems` for one bad record, and refuses ids with path characters.
- [ ] Actions validate their body and throw `{ status, message }` on bad input.
- [ ] `curl /api/sources` shows no `error` for your source.
