# Mission Control with Codex CLI

Everything a Codex CLI user needs: what the dashboard reads from Codex, how spawned agents show up, how to turn on the Needs you queue with Codex hooks, and what to do when something looks wrong.

Codex support needs no setup (level 0). Hooks (level 1) are optional and add the Needs you queue.

## Run it

```bash
git clone https://github.com/aldefy/mission-control
cd mission-control
npm ci
npm run build
node bin/mission-control.mjs
```

Codex is on whenever `$CODEX_HOME/sessions` exists (`CODEX_HOME` defaults to `~/.codex`, as in Codex itself), and sits next to Claude Code if you use both. Open `http://localhost:4319`; Codex sessions carry the harness `codex`.

```bash
CODEX_HOME=/work/codex-home node bin/mission-control.mjs              # Codex home elsewhere
node bin/mission-control.mjs --codex-dir /work/codex-home/sessions   # or name the sessions dir directly
node bin/mission-control.mjs --no-claude                              # Codex only
node bin/mission-control.mjs --no-codex                               # leave Codex out
```

`--codex-dir` takes the `sessions` directory itself, wins over `CODEX_HOME`, and turns Codex on even when that directory's parent does not exist.

## What it reads

Codex writes one "rollout" file per session, by start date:

```
~/.codex/sessions/
  2026/11/02/
    rollout-2026-11-02T09-15-00-<thread-id>.jsonl
```

Each line is `{ "timestamp", "type", "payload" }`. These records are used, and everything else is ignored:

| record | fields | used for |
|---|---|---|
| `session_meta` (the first line) | `id`, `session_id`, `cwd`, `git.branch`, `cli_version`, `timestamp`, `source` | identity, project and worktree, branch, start time; `source.subagent.thread_spawn.parent_thread_id` marks a spawned agent |
| `turn_context` | `model` | the model of the turns that follow |
| `event_msg` `user_message` | `message` | the title and your turns in the chat |
| `response_item` `message` | `role`, `content[].text` | assistant turns; in `codex exec` sessions (no `user_message` events) your prompt, skipping the context Codex injects such as `<environment_context>` and `AGENTS.md` |
| `response_item` `function_call` | `name`, `namespace`, `arguments`, `call_id` | calls: `exec_command` and other tools; `namespace: "mcp__<server>"` makes it an MCP call of that server; `spawn_agent` is an agent call |
| `response_item` `custom_tool_call` | `name`, `input`, `call_id` | calls such as `exec` scripts and `apply_patch` (summarised by the files it touches) |
| `response_item` `local_shell_call`, `web_search_call` | `action` | calls in older and web-search sessions |
| `response_item` `function_call_output`, `custom_tool_call_output` | `call_id`, `output` | each call's result and duration; an error when the output says `Process exited with code N` or `Exit code: N` with N not 0, `Script failed`, or `apply_patch verification failed` |
| `event_msg` `mcp_tool_call_end`, `patch_apply_end` | `call_id`, `result` / `success`, `duration` | MCP and patch errors and durations |
| `event_msg` `token_count` | `info.last_token_usage`, `info.total_token_usage` | tokens and estimated cost |

Token counting: each `token_count` with a new running total adds its `last_token_usage`; a repeated total (Codex refreshes rate limits with the same numbers) adds nothing. OpenAI counts cached input inside `input_tokens`, so the dashboard shows input as `input_tokens - cached_input_tokens` and the cached part as cache read.

The home list reads only the head of each rollout (the session meta and your first message) plus its size and time. A session's totals fill in the first time you open it; until then the list shows "–". A half-written last line (Codex still writing) is skipped.

A session is **live** (working) while one of its rollout files changed in the last two minutes.

## Spawned agents are lanes

When Codex spawns agents (multi-agent mode), each one writes its own rollout whose `session_meta` names the parent thread. The dashboard folds those into the session that started them:

- each spawned agent is a lane `agent-<thread-id>` labelled with its nickname (else its role or path), with its model and role;
- an agent spawned by another agent hangs under that agent's lane;
- its calls, tokens and cost count toward the session; the Chat tab shows each lane on its own.

Spawned agents never appear as sessions of their own on the home page.

## Costs

Costs are API list-price estimates, marked "est." on the page. OpenAI prices are a dated table in `src/sources/claude-code/prices.mjs` (for example `gpt-5` at $1.25 per million input tokens, $0.125 cached, $10 output; `gpt-5.6-sol` at $4 / $0.40 cached / $20, with a cache write at the listed 30-minute rate of $5). Newer models are taken from OpenAI's pricing page at the short-context (up to 272K input) Standard rate; longer prompts are billed higher by OpenAI and are underestimated here. Only model ids in that table are priced, after dropping a date suffix such as `-2025-08-07`. Any other id, including a newer version, costs 0 and shows as "–" (no price) rather than borrowing an older model's price. If you use Codex with a ChatGPT plan you are not billed per token at all; the number shows what the same tokens would cost on the API.

## Turns

The Turns tab lists one row per `token_count` event (a model call): input, cached input, cache write and output tokens with an estimated cost, sortable by cost, with a marker where the context dropped sharply.

### Steering a running session (v2.6)

A session's page has a **Steer this session** box while the session is open. A message sent there waits in `~/.mission-control/steer/` (0700) until the agent's current turn ends. The session's `Stop` hook then answers `{"decision": "block", "reason": <your message>}`, so the agent carries on with it as its next prompt instead of stopping. Messages sent during one turn are handed over together, in order, and each is delivered once. You can cancel one while it waits.

Claude Code 2.1 marks the handover with a "Stop hook error occurred" notice; that is how it labels any Stop hook that keeps a turn going (checked with `claude -p`: the agent answers the queued message next). It needs the hooks. An idle session has no turn to end, so the message waits until the next turn you start in the terminal.

## Needs you: Codex hooks

Codex CLI runs hooks configured in `~/.codex/hooks.json` (or `[hooks]` tables in `~/.codex/config.toml`, and per repository in `.codex/`). Hooks are on by default; `[features] hooks = false` in `config.toml` turns them off. Codex sends each hook a JSON object on stdin with `session_id`, `hook_event_name`, `cwd`, `model` and per-event fields. Its `PermissionRequest` event fires when Codex is about to ask you for approval. That is what Mission Control listens to.

1. Print the block for this checkout:

   ```bash
   node bin/mission-control.mjs hooks install codex
   ```

   It prints something like this, with your own `node` path and checkout path:

   ```json
   {
     "hooks": {
       "PermissionRequest": [
         {
           "hooks": [
             {
               "type": "command",
               "command": "'/usr/local/bin/node' '/work/mission-control/bin/mission-control.mjs' hook codex",
               "timeout": 135
             }
           ]
         }
       ],
       "PreToolUse": [
         {
           "hooks": [
             {
               "type": "command",
               "command": "'/usr/local/bin/node' '/work/mission-control/bin/mission-control.mjs' hook codex",
               "timeout": 10
             }
           ]
         }
       ],
       "PostToolUse": [
         {
           "hooks": [
             {
               "type": "command",
               "command": "'/usr/local/bin/node' '/work/mission-control/bin/mission-control.mjs' hook codex",
               "timeout": 10
             }
           ]
         }
       ],
       "UserPromptSubmit": [
         {
           "hooks": [
             {
               "type": "command",
               "command": "'/usr/local/bin/node' '/work/mission-control/bin/mission-control.mjs' hook codex",
               "timeout": 10
             }
           ]
         }
       ],
       "Stop": [
         {
           "hooks": [
             {
               "type": "command",
               "command": "'/usr/local/bin/node' '/work/mission-control/bin/mission-control.mjs' hook codex",
               "timeout": 10
             }
           ]
         }
       ],
       "Interrupt": [
         {
           "hooks": [
             {
               "type": "command",
               "command": "'/usr/local/bin/node' '/work/mission-control/bin/mission-control.mjs' hook codex",
               "timeout": 10
             }
           ]
         }
       ],
       "SubagentStop": [
         {
           "hooks": [
             {
               "type": "command",
               "command": "'/usr/local/bin/node' '/work/mission-control/bin/mission-control.mjs' hook codex",
               "timeout": 10
             }
           ]
         }
       ]
     }
   }
   ```

2. Merge it into `~/.codex/hooks.json` by hand (create the file if it is missing). If the file already has hooks for an event, add the inner `{ "type": "command", ... }` entry next to them.

3. Start Codex and run `/hooks`. Codex lists hooks it has not seen before as untrusted and does not run them until you review and trust them there.

4. Check it: ask Codex to do something that needs approval under your approval policy (for example a command outside the sandbox). The session shows under **Needs you** with "Codex needs your approval to use <tool>: <command>" (the command or path, cut to 120 characters, secrets masked). Approve or deny it in Codex and it leaves the queue.

Since v2.3 the `PermissionRequest` entry has `"timeout": 135` (`remote.waitSeconds`, default 120, plus 15 s; it was 10) so a [paired phone](remote-answering.md) can answer the approval. Every other entry stays at 10. **If you merged an older block, run `hooks install codex` again, merge it, and re-trust the changed hook with `/hooks` in Codex.** With the old `timeout: 10`, Codex stops the hook after 10 s and you answer in Codex, which is safe.

The paths in the block are absolute. **Run `hooks install codex` again and merge again after you move the checkout or upgrade Node.**

### What the hook records

Every entry runs `mission-control hook codex`. It reads Codex's JSON, maps the event and appends one line to `~/.mission-control/hooks/codex/<session_id>.jsonl` (or under `MISSION_CONTROL_HOOKS_DIR`):

| Codex event | recorded as | effect |
|---|---|---|
| `PermissionRequest` | `Notification`, with a message naming the tool and its masked target | the session is waiting on you |
| `PreToolUse`, `PostToolUse` | `PreToolUse` | clears the wait for the same tool call (the tool was approved and runs) |
| `UserPromptSubmit` | `UserPromptSubmit` | clears a wait |
| `Stop` | `Stop` | clears a wait; the turn ended, so the session is **Ready** for 30 minutes |
| `Interrupt` | `Stop` | clears a wait (you interrupted it); not ready |
| `SubagentStop` | `SubagentStop` | recorded, no effect on waiting |

Other events (`SessionStart`, `SessionEnd`, compaction) are ignored. Only the event, session id, time, tool name, the tool call id (when the payload has `tool_use_id` or `call_id`), the approval message and, for `PermissionRequest` and `PreToolUse`, a short target (the first 120 characters of the command or file path, secrets masked) are kept; the model's free-text `description` and other tool inputs and outputs are not stored. The hook always exits 0 and prints only an allow or deny a paired phone gave (see [remote answering](remote-answering.md)); otherwise nothing.

```jsonl
{"event":"Notification","codexEvent":"PermissionRequest","sessionId":"0199a1b2-...","ts":"2026-11-02T10:01:00.000Z","tool":"Bash","callId":"call_a1","target":"npm install","message":"Codex needs your approval to use Bash: npm install"}
{"event":"PreToolUse","codexEvent":"PostToolUse","sessionId":"0199a1b2-...","ts":"2026-11-02T10:01:05.000Z","tool":"Read","callId":"call_b2"}
{"event":"PreToolUse","codexEvent":"PreToolUse","sessionId":"0199a1b2-...","ts":"2026-11-02T10:01:20.000Z","tool":"Bash","callId":"call_a1"}
```

Waits are kept per tool call: with parallel tools, a sibling call starting or finishing (`call_b2` above) does not clear the approval still open for `call_a1`; a hook line without a call id clears every wait, as before. A wait also clears when the rollout gets a newer response item (Codex moved on), and it expires after 12 hours.

### What is not covered

- Codex has no idle reminder, so **Ready** comes from the `Stop` hook: a session whose last turn ended less than 30 minutes ago (and has not moved on since) counts in the **Ready (N)** chip; after that it is plain idle. Without hooks Codex sessions are never ready.
- **Looping** works for Codex too: the same `exec_command` failing again and again, or `apply_patch` → test → same failure, shows as looping on the lane card.
- The older `notify` setting in `config.toml` only fires when a turn completes, so it is not used for Needs you.
- From a [paired phone](remote-answering.md) you can **allow or deny** a Codex approval, nothing else: no option prompts (no Codex hook for them has been found), no changes to the approval policy. Each parallel tool call gets its own prompt, keyed by its call id. Codex hooks are a guardrail, not a complete enforcement boundary.
- Without remote answering on and a paired device, approvals happen in Codex as before.
- With remote answering on and a device paired, **Codex hides its approval dialog while the hook waits** (observed with codex-cli 0.159.3). The dialog appears after `remote.waitSeconds` (default 120) unless the phone answers first. At the desk, lower `remote.waitSeconds` or run `mission-control remote off`.
- Codex's `PermissionRequest` payload has no call id, so a phone answer is matched to the session's open approval, not to one tool call.

## Privacy

- Everything stays on your machine. The server binds to `127.0.0.1` and `::1` only; the page loads nothing from the internet.
- `~/.codex` (or `$CODEX_HOME`) is only read, never written. Rollouts are read from `sessions/YYYY/MM/DD/rollout-*.jsonl`, and symlinks out of the sessions directory are refused. `config.toml` is scanned for `[mcp_servers.<name>]` table names only (for the Calls tab's "Config vs calls"); no value in it is read. `auth.json`, the SQLite databases and `history.jsonl` are never read.
- The only files written are the hook logs (`~/.mission-control/hooks/codex`) and a usage cache (`~/.mission-control/cache`, mode 0600: project paths, session ids and token sums, no conversation text).

## Troubleshooting

| symptom | cause and fix |
|---|---|
| No Codex sessions, and no `codex` in `curl -s http://localhost:4319/api/sources` | `~/.codex/sessions` does not exist (no Codex session has run yet, or `CODEX_HOME` points elsewhere). Pass `--codex-dir <your codex home>/sessions`. |
| `codex` is listed but no sessions show | The directory has no `YYYY/MM/DD/rollout-*.jsonl` files. Run one Codex session and reload. |
| A session has no title | Its first message is still being written, or it only holds injected context. The id is shown instead. |
| Cost is 0 | The model id is not in the dated OpenAI table (see Costs). Add it to `OPENAI_PRICES` if you want an estimate. |
| Needs you never fills | The hooks are not merged, not trusted in `/hooks`, or hooks are off in `config.toml`. Check that `~/.mission-control/hooks/codex/` gets files while Codex runs. |
| Codex reports a hook error after moving the repo | The block holds absolute paths. Run `hooks install codex` again and replace the old entries. |
| Spawned agents show as separate sessions | Their parent rollout is missing (deleted or outside the sessions directory). They stand alone until it is back. |
