# pi-bg

Background jobs and services for [pi](https://pi.dev). It works on its own, and works with
[herdr](https://herdr.dev) through [pi-herdr](https://github.com/justmytwospence/pi-herdr) when
both are there.

- A **job** is a finite command whose result the agent needs (tests, builds, model fits, exports).
  It wakes the agent with its outcome when it exits, unless the agent waited for it with `bg_wait`.
- A **service** keeps running (a dev or notebook server, a tunnel, a watcher). With a `ready`
  pattern it wakes the agent once when a log line matches; it also wakes it if it exits.
- **Waiting is part of the turn.** When nothing is left but a job's result, the agent calls
  `bg_wait` instead of ending its turn, so pi, herdr and tmux show it as working until the job
  ends. Typing a message stops the wait (the job keeps running and still wakes the agent), as do
  Esc and the wait's timeout.
- **The UI is Claude Code's**: a pill under the prompt and a background-tasks dialog (below), so it
  feels the same as Claude Code, and close to Codex and Gemini CLI.

## Tools

| tool | |
|---|---|
| `bg_run` | `command`, `kind` (`job` or `service`, required), `name`, `ready` (service: a regex, case-insensitive, or `/src/flags`), `timeout` (job: seconds), `keep` (service: outlive this pi session), `cwd` |
| `bg_wait` | `id` (a task, or outside work; default the next job to end), `timeout` (seconds, default 1800, max 3600) |
| `bg_logs` | `id` (omit to list every task), `lines`, `grep`, `head` |
| `bg_kill` | `id`: SIGTERM to the process group, SIGKILL after 3 s |

Ids also accept a task's name or a unique id prefix. A command that fails within 1.5 s is reported
in `bg_run`'s own result.

A wake-up goes out only while pi is idle: one that comes due during a turn waits for the turn to
settle (a follow-up queued mid-turn is dropped when you press Esc), and several that pile up go out
as one message. Whatever `bg_wait`, `bg_logs` or `bg_kill` has already shown the agent is no longer
owed. A task that ends during `/reload` wakes the agent once the new session is up.

## Processes and files

Each task runs `bash -c <command>` in its own process group, stdout and stderr appended to
`~/.pi/agent/bg/<session>/<id>.log` (nothing is written into the project; `PI_BG_DIR` moves it).
A log past 64 MB is cut back to its last megabyte. Tasks survive `/reload` (the new code takes the
running tasks over). Quitting, `/new`, `/resume` and `/fork` stop them, along with anything a task
left running in its process group (`npm run dev &`), except services with `keep: true`: those keep
running, and the next pi started in or above their directory adopts them (lists them, can stop
them). Each pi records its running tasks in `~/.pi/agent/bg/state/<pid>.json`, so a pi that crashed
has its leftovers killed by the next one; a pid is only signalled or adopted while it still runs the
task's command, never when it has been reused. Logs older than a week are deleted.

## UI

Laid out the way Claude Code does it (2.1.296), with the same keys:

- **Pill under the prompt**: `1 shell`, `2 shells`, and `· 1 failed` in the error color while a
  failure you have not seen is there (until your next message, or `x` in the dialog). `↓` at an
  empty prompt selects it, Enter (or a click, in fullscreen mode) opens the dialog, Esc or `↑` goes
  back. Nothing above the prompt.
- **Background-tasks view** (`/tasks`, also `/bashes`, `/ps`, `/bg`): it takes over the whole
  screen, as Claude Code's and Codex's subagent views do, under an accent-colored banner
  (`◀ esc · Background tasks · not your main session`); Esc goes back. Every task, running first,
  then what ended (newest first), each with its command and state (`waiting` while a `bg_wait` is on
  it, `ready` for a service). ↑↓ select; Enter opens the task's live log (↑↓ PgUp/PgDn g/G scroll,
  `x` twice stops, Esc comes back to the dialog); `x` twice stops a running task, `x` on an ended one
  dismisses it; `r` reruns; `f` follows the log in a herdr split; Esc closes.
- **Commands**: `/tasks run <command>` starts a job yourself (it notifies you when it ends and does
  not wake the agent), `/tasks kill <id>`, `/tasks clear` hides ended tasks, and `/stop` (Codex's)
  stops every task this pi started.
- **Outside the TUI** (RPC), a footer status `bg: tests 2:14 · vite ready · lint ✗` instead, which
  [pi-status-footer](https://github.com/justmytwospence/pi-status-footer) gives a row of its own.

## With pi-subagents

Both work alone. With [pi-subagents](https://github.com/justmytwospence/pi-subagents) installed
too, they work as one, as in Claude Code (the activity protocol in `src/activity.ts`, copied into
both repos):

- **One list under the prompt.** pi-subagents' list (Claude Code's subagent panel: `main` and the
  subagents) ends with this pill; ↓ moves through the subagents to the pill, and Enter on it opens
  the dialog. pi-bg draws no pill of its own then.
- **One dialog.** `/tasks` lists the subagents too, under their own heading: Enter opens a run's
  conversation, `x` twice stops it, `x` on an ended one dismisses it.
- **Waiting on subagents.** Async subagent runs are outside work `bg_wait subagent:<id>` can wait
  on inside the turn; the `subagent` tool's result names the ids. The run's result still arrives as
  its own message.

## Other extensions

All through `pi.events`; with nothing listening, nothing happens.

| channel | direction | payload | |
|---|---|---|---|
| `herdr:background` | emits | `{ active, label, id }` | held while an agent job runs that will wake the agent: pi-herdr shows it as the pane token `$bg` when the agent ends its turn instead of waiting |
| `herdr:notify` | emits | `{ title, body, sound, unlessFocused }` | a task you started (or a kept service) ended |
| `herdr:split` | emits | `{ command, cwd, done }` | the dialog's "follow in a split" (`tail -F` on the log), offered when pi-herdr answers `herdr:probe` |
| `bg:tasks` | emits | `{ tasks }` | a snapshot after every change: id, name, kind, command, cwd, status, ready, origin, keep, `willWake`, logPath |
| `bg:killed` | emits | `{ id, command, cwd }` | after a task is stopped |
| `bg:external` | reads | `{ id, label, state, summary? }` | outside work `bg_wait <id>` can wait on (`state`: `running`, `done`, `failed`), e.g. a busy marimo notebook |
| `bg:probe` | reads | `{ reply }` | `reply()` when pi-bg is loaded |
| `activity:section`, `activity:changed`, `activity:gone` | both | `{ section }`, `{ id }` | sources of background work: ours (the pill, entries, the dialog) for a host to show under the prompt; others' (pi-subagents' runs) for the dialog; see `src/activity.ts` |
| `activity:host` | reads | `{}` | a host is ready: offer our source again |

herdr's pane state stays herdr's own (its pi integration): working while a turn runs, which
`bg_wait` extends. When the agent ends its turn with a job running, the pane is idle or done and
the `$bg` token names the job until it wakes the agent.

**marimo.** A marimo-pair `execute-code` call blocks until the cells it ran finish, so a long run
is a job (`bg_run` the call, then `bg_wait`). Stopping that job stops the client, not the cells:
`bg_kill` says so for marimo-pair commands. While it runs, other `execute-code` calls to the same
notebook queue behind it.

## Development

```sh
npm install
npm run check   # typecheck + tests (real processes, no model calls)
pi -ne -e . -e <provider extension>   # try it in a pi without other extensions
```

MIT licensed.
