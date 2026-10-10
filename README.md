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

## Tools

| tool | |
|---|---|
| `bg_run` | `command`, `kind` (`job` or `service`, required), `name`, `ready` (service: a regex, case-insensitive, or `/src/flags`), `timeout` (job: seconds), `keep` (service: outlive this pi session), `cwd` |
| `bg_wait` | `id` (a task, or outside work; default the next job to end), `timeout` (seconds, default 1800, max 3600) |
| `bg_logs` | `id` (omit to list every task), `lines`, `grep`, `head` |
| `bg_kill` | `id`: SIGTERM to the process group, SIGKILL after 3 s |

Ids also accept a task's name or a unique id prefix. A command that fails within 1.5 s is reported
in `bg_run`'s own result.

## Processes and files

Each task runs `bash -c <command>` in its own process group, stdout and stderr appended to
`~/.pi/agent/bg/<session>/<id>.log` (nothing is written into the project; `PI_BG_DIR` moves it).
Tasks survive `/reload`. Quitting, `/new`, `/resume` and `/fork` stop them, except services with
`keep: true`: those keep running, and the next pi started in or above their directory adopts them
(lists them, can stop them). `~/.pi/agent/bg/state.json` records running tasks, so a pi that
crashed has its leftovers killed by the next one. Logs older than a week are deleted.

## UI

- **Widget** above the editor, like pi-subagents': each running task (spinner, name, kind, time,
  `waiting` while a `bg_wait` is on it, `yours` for `/bg run`, `kept`, the command) with its latest
  log line beneath, then what ended (8 s after success, 20 s after a failure or stop, with the last
  line of a failure). It hides when nothing is left to show.

  ```
  ● Background  1 running, 1 service
  ├─ ⠋ tests  job · 2:14 · waiting · npm test
  │    ⎿  ✓ 212 passed, 3 skipped
  ├─ ● vite  service · ready 0:34 · npm run dev
  │    ⎿  Local: http://localhost:5173/
  └─ ✗ lint  exit 1 after 0:10 · src/a.ts:3 unused import
  ```
- **Footer** status `bg` instead, with `/bg widget off` (saved in `~/.pi/agent/bg/settings.json`)
  or outside the TUI: `bg: tests 2:14 · vite ready · lint ✗`. [pi-status-footer](https://github.com/justmytwospence/pi-status-footer)
  gives it a row of its own.
- **`/bg`**: pick a task, then view its log (a live overlay: ↑↓ PgUp/PgDn g/G, `x` twice stops,
  Esc closes), stop, rerun, follow it in a herdr split, or put its log path in the editor.
  `/bg run <command>` starts a job yourself (it notifies you when it ends and does not wake the
  agent), `/bg kill <id>`, `/bg clear` hides ended tasks, `/bg widget on|off`.

## Other extensions

All through `pi.events`; with nothing listening, nothing happens.

| channel | direction | payload | |
|---|---|---|---|
| `herdr:background` | emits | `{ active, label, id }` | held while an agent job runs that will wake the agent: pi-herdr shows it as the pane token `$bg` when the agent ends its turn instead of waiting |
| `herdr:notify` | emits | `{ title, body, sound, unlessFocused }` | a task you started (or a kept service) ended |
| `herdr:split` | emits | `{ command, cwd, done }` | `/bg`'s "follow in a herdr split" (`tail -F` on the log), offered when pi-herdr answers `herdr:probe` |
| `bg:tasks` | emits | `{ tasks }` | a snapshot after every change: id, name, kind, command, cwd, status, ready, origin, keep, `willWake`, logPath |
| `bg:killed` | emits | `{ id, command, cwd }` | after a task is stopped |
| `bg:external` | reads | `{ id, label, state, summary? }` | outside work `bg_wait <id>` can wait on (`state`: `running`, `done`, `failed`), e.g. a busy marimo notebook |
| `bg:probe` | reads | `{ reply }` | `reply()` when pi-bg is loaded |

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
