# Roadmap

Ideas and fixes, roughly in the order they'll land. Many came from people trying the dashboard; thanks.

## Done in v2.1

- **Stale prompt safety.** Answering a permission prompt in the terminal while the dashboard is down must clear "Needs you" when it reconnects, and a new prompt replacing an old one must look new: each card shows the tool, the command or target, and when it was asked, and briefly flags "new prompt". A test covers prompt → dashboard down → answered in terminal → reconnect.
- **Ready vs needs you.** "Done, waiting for your next prompt" stays out of the Needs you queue but gets its own calm "Ready (N)" chip, so idle sessions are findable without looking urgent.
- **Looping detection.** A session silently retrying a failing test is the expensive kind of stuck. New "Looping" state when the same tool and command fails N times in a row, or an edit → test → fail cycle repeats on the same failure, or tokens keep burning with no new passing check. The card says how long, how many failures and the estimated cost since it started, with a link to the first failing call. Thresholds are configurable.
- **Tokens since last file change** (from replies). Per lane and per item: new tokens (input, output, cache write) and time passed since the last successful file edit, reset by every Edit / Write / apply_patch (a failed edit does not count); cache reads are shown apart and never counted. Shown on lane cards ("41k tok (+3.1M cached) since last change · 18m") and as a sortable column in the Home and project tables, and used by the looping rule for burning tokens (300k new tokens, or an optional est. cost, and 10 minutes with no file change, no passing check, and 3 failures or a failed check; configurable).
- **Faster "Needs you".** Claude Code's PermissionRequest hook (fires when the permission dialog opens, not ~6 s later like the permission Notification, which stays as the fallback), and `GET /api/events` pushes "changed" to the page as soon as a hook line lands or a live session file grows; polling stays as the fallback.

## Done in v2.2

- Fixed: the Usage page left blank space under the harness cards at some widths, and one empty cell on phones.
- Fixed: a subagent file that failed to read once stayed hidden until it changed; it is now retried on the next request.
- Fixed: Haiku 3 was priced at the Haiku 3.5 rate; it now has its own list price.
- Fixed (Codex): a sibling tool call's hook could clear a wait while another approval was still open (parallel tools). Waits are keyed by tool call id when the hook payload has one.
- Codex: `CODEX_HOME` is honoured (sessions default to `$CODEX_HOME/sessions`).
- Prices for newer OpenAI models (gpt-6-astra, gpt-6.1-sol, gpt-5.6-sol/terra/luna, gpt-5.5, gpt-5.4, gpt-5.4-mini) from OpenAI's pricing page, short-context Standard rates. Models not on that page stay unpriced (–).
- Calls joined to config: the Calls tab lists each configured MCP server and skill as used, loaded but not used, or failing (by error rate); the project page names MCP servers no recent session called. Config files are read for names only.
- Same-file warning: two sessions or runs of one project (any worktrees) that edited the same repo-relative path within 30 minutes show a warning on the project page and on both items' rails.
- Turns view: each assistant turn's input, cache read, cache write and output tokens with an estimated cost, sortable by cost, with markers where the context dropped sharply (compaction) and a short "why expensive" hint. Claude Code and Codex.
- Cost per pull request (branches mapped to PRs through `gh`, cached, optional) and budgets per project, worktree or branch in `~/.mission-control/config.json`, with bars on the Usage page and a top-bar chip at 80% and 100%.
- Usage-window estimate (Claude Code): the current rolling window from local logs, with "at this rate you hit the limit in ~1h 40m" when you set your own limit in `config.json` (`usageWindow`), or "no limit set". Always labelled an estimate; it never claims Anthropic's actual limits.
- Hook targets mask obvious secrets; the Codex approval message shows the masked command, never the model's description.
- A subagent's permission request that Claude Code auto-denies (background, no prompt possible) leaves Needs you after 10 s unless the permission notification confirms it.
- Checks are recognised by the program at the head of a command (or the npm/pnpm/yarn/bun script name), not by a word anywhere in it.
- Same-file warnings ignore a resumed or forked session replaying its parent's edits; PR lookups run in parallel per project.

## Done in v2.3

- **Answer prompts from your phone.** Allow once / deny a Claude Code or Codex permission prompt, or pick an option of a Claude Code AskUserQuestion, from a paired phone over your tailnet. A second loopback listener behind `tailscale serve`, one-time QR pairing, per-device cookies, answers bound to what the phone showed, hooks that fail open to the terminal, and an audit log. See [docs/remote-answering.md](docs/remote-answering.md).
- Installable phone app (PWA) with a mobile Needs you list.

## Done in v2.4

- **`mission-control remote setup`**: one command from zero to a paired phone. It checks Tailscale, writes the config, merges the hooks into Claude Code and Codex settings (with a backup, asking first), runs `tailscale serve`, turns it on and shows the QR. **`remote doctor`** shows what is missing.
- **Phone notifications** (opt-in): a new prompt sends an empty Web Push ping; the app fetches the details over the tailnet.
- Answerable prompts are listed first on the phone; the app reconnects when it comes back to the foreground.

## Done in v2.5

Session management, from Ayush Priyam's work (#3, #4, #5):

- **Real session state from Claude Code's process files.** Open, closed, working and Ready come from `sessions/<pid>.json`, so Ready fills at once without hooks and idle sessions no longer read as working. A reused pid does not count as open. A **Closed** chip, closed rows dimmed and last, and **Show** on Recent: open only, closed, all, archived.
- **Rename, pin, archive, resume.** Rename a session from the page (Claude Code's `/rename` and generated titles are used by default), pin it to the top, archive it, or copy its `claude --resume` command. A chat that moved to a new session id is listed once, and Claude Code's latest recap shows on the session page.
- **Notifications, off by default.** Needs you and Done, each sent to one place only: a dashboard tab in view, a paired phone, a background tab or macOS. Phone pings that no push service accepts, and tabs that cannot show one, fall through to the next.
- **Start at login** (macOS, LaunchAgent) and **Keep sessions** (Claude Code's `cleanupPeriodDays`), both opt-in from the sidebar.
- **A guided tour** over one of your own sessions, from the **?** in the top bar.
- CI runs on Node 20.19, 22 and 24.
- Fixed: session titles disappeared from the Recent table on a 1440px-wide screen.

## Done in v2.6.1

- **An agent's question inside a run is Needs you.** When an agent in a harness run (Ronin's OpenCode researcher, for example) pauses on a question or a permission request, the run now waits on you: it shows in Needs you with the question as its reason. The run page shows a form with each question's options. Your answer goes back through the adapter's `reply` or `approve` action.
- The question clears as soon as your answer is saved or the run ends. The right-hand card points to the form instead of offering Approve (sign), which does not apply to an agent question.
- An `unverified` stop (Ronin's report contract) waits on you like a `human` stop, instead of reading as stopped.
- A run with no checks, such as a research run, ends as Done instead of "built, not verified".

## Done in v2.6

From a study of iii.dev and ThreadPage:

- **Steer a running session.** A session page has a Steer box. The message waits until the agent's turn ends. Its Stop hook then hands it over as the next prompt (Claude Code and Codex), so the agent carries on with it. Each message is delivered once, and a waiting one can be cancelled.
- **The trace beside the chat**, live: every tool call by lane, with duration and failures, pushed rather than polled. It sits beside the chat on very wide screens and under it otherwise.
- **The run page says plainly where a run stands:**
  - Done and verified;
  - built but not verified, with what is left listed first;
  - waiting for you, and why;
  - or working on a given stage.

  The latest app screenshot sits beside it, and the QA tab shows QA working step by step.
- **Pane plugins.** An adapter can ship its own tabs (`ui`, one ES module, see docs/own-harness.md). Ronin uses it for a Reports tab: each stage's checked report of what it ran, what it did not verify and what it assumed.

## Done in v2.5.1

A security update, from an audit of 2.5.0:

- Fixed: a crafted session title could run a command through a macOS notification (escaping happened before the 200-character cut). The text now goes to `osascript` as arguments to a fixed script.
- The phone offers Allow only when it shows the whole action: a one-line Bash or Read (or Codex shell) command or path of up to 120 characters. Everything else is answered at the computer, and the server and the hook refuse a phone answer to it.
- No other site can frame the dashboard (`X-Frame-Options: SAMEORIGIN`, `frame-ancestors 'self'`).
- For contributors: a release skill and the scripts behind the release media.

## Later

- Cost per task (spec-kit task, Ronin stage).
- Steer from the phone: send a session a new instruction (v2.3/v2.4 answer prompts only).
- Answer Ronin stops (sign, approve a design, pick, reply) from the phone through the adapter's actions.
- Rewind or fork a session from its log.
- More readers: opencode, Pi.
- A terminal UI over the same data.
- Fleets (from a reply showing Skiff): a level above projects that groups several repos, so one view covers a release across all of them.
- Hand-off ledger: what was handed from one session or run to another, to whom, and how far along it is (for example 0/4 items done), with a link to each result.
- Unread: sessions and runs that finished since you last opened them, as a count in the top bar and a dot in the sidebar.

## Known small issues

None open right now.

## Verified on a device, 2026-11-03

- **Device:** an iPhone on the same tailnet as a MacBook (macOS), Safari and the Home Screen app, through `tailscale serve`.
- **Checked:** pairing by QR; the Host and Origin checks behind `tailscale serve` (pairing and answers succeed, so the name passes through unchanged); `remote setup` merging the hooks while keeping the owner's other hooks, with a backup; a permission prompt sent through the real hook binary, shown on the phone and allowed there, with the hook returning `allow` and one audit line; a notification arriving with the phone locked and opening the app.
- **Found and fixed on the device:** the live prompt was listed under old read-only entries; Apple refused the `Topic` header; the app said "offline" after coming back from the background.
- **Not checked on a device:** Android; a Codex prompt answered from the phone; AskUserQuestion answered from the phone.
