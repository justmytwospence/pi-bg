// pi-bg: background jobs and services for pi.
//
// - bg_run starts a job (a finite command whose result the agent needs) or a service (a server,
//   tunnel or watcher). A job wakes the agent when it exits; a service wakes it once when its
//   `ready` pattern matches, or if it exits.
// - bg_wait keeps the turn going until a job ends, so the agent is visibly working (in pi, herdr,
//   tmux) while it waits. It returns early when the user types, on Esc, or after its timeout.
// - bg_logs reads a log (or lists the tasks); bg_kill stops one.
// - Footer status `bg` (pi-status-footer gives it a row), `/bg` to list, view, stop and rerun.
//
// Other extensions, through pi.events (all optional; without listeners nothing happens):
//   emits  herdr:background {active,label,id}  while an agent job runs that will wake the agent
//                                              (pi-herdr shows it as the pane token $bg)
//          herdr:notify {title,body,sound,unlessFocused}  when a task the user started ends
//          herdr:split {command,cwd}           /bg's "follow in a herdr split" (when pi-herdr answers herdr:probe)
//          bg:tasks {tasks}                    a snapshot after every change
//          bg:killed {id,command,cwd}          after bg_kill or /bg stops a task
//   reads  bg:external {id,label,state,summary?}  outside work bg_wait can wait on (state running|done|failed)
//          bg:probe {reply}                    reply() when pi-bg is loaded
import path from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { elapsed, footerStatus, header, marimoNote, nameFromCommand, outcome, report, runtime, taskLine } from "./format.ts";
import { bounded, grep, head, tail } from "./log.ts";
import { type Kind, type Task, type TaskEvent, parsePattern, registry } from "./registry.ts";
import { LogViewer } from "./viewer.ts";

const STARTUP_WAIT_MS = 1_500;
const WAIT_DEFAULT_S = 1_800;
const WAIT_MAX_S = 3_600;
const LOGS_DEFAULT = 60;
const LOGS_MAX = 400;
const LOGS_BYTES = 12_000;

export interface External {
  id: string;
  label: string;
  state: "running" | "done" | "failed";
  summary?: string;
  updatedAt: number;
}

type Reason = "done" | "message" | "timeout" | "aborted";

interface Waiter {
  /** Task or external ids; empty means any running agent job. */
  targets: Set<string>;
  any: boolean;
  /** bg_run's short startup check: takes only its own task, never other tasks' news. */
  silent: boolean;
  finished: Task[];
  readied: Task[];
  externals: External[];
  /** Other tasks that ended (or got ready) meanwhile; delivered with this wait's result. */
  extras: string[];
  resolve: (r: Reason) => void;
}

const RunParams = Type.Object({
  command: Type.String({ description: "Shell command (bash -c), run in its own process group with stdout and stderr to a log file" }),
  kind: Type.Union([Type.Literal("job"), Type.Literal("service")], {
    description: "job: finite, you need its result (tests, builds, fits, exports, long scripts). service: keeps running (dev or notebook servers, tunnels, watchers)",
  }),
  name: Type.Optional(Type.String({ description: "Short label for the footer and lists, e.g. `tests`, `vite`" })),
  ready: Type.Optional(Type.String({ description: "service: regex (case-insensitive, or /src/flags) for the log line that means it is up; you are woken once when it matches" })),
  timeout: Type.Optional(Type.Number({ description: "job: kill it after this many seconds" })),
  keep: Type.Optional(Type.Boolean({ description: "service: leave it running when this pi session ends (a server the user works in)" })),
  cwd: Type.Optional(Type.String({ description: "Working directory (default: the session's)" })),
});

const WaitParams = Type.Object({
  id: Type.Optional(Type.String({ description: "Task id or name; default: whichever running job ends first" })),
  timeout: Type.Optional(Type.Number({ description: `Seconds to wait at most (default ${WAIT_DEFAULT_S}, max ${WAIT_MAX_S})` })),
});

const LogsParams = Type.Object({
  id: Type.Optional(Type.String({ description: "Task id or name; omit to list all tasks" })),
  lines: Type.Optional(Type.Number({ description: `Lines to return (default ${LOGS_DEFAULT}, max ${LOGS_MAX})` })),
  grep: Type.Optional(Type.String({ description: "Only lines matching this regex (case-insensitive, or /src/flags)" })),
  head: Type.Optional(Type.Boolean({ description: "The first lines instead of the last" })),
});

const KillParams = Type.Object({ id: Type.String({ description: "Task id or name" }) });

const text = (t: string) => ({ content: [{ type: "text" as const, text: t }], details: {} });

export default function piBg(pi: ExtensionAPI) {
  const reg = registry();
  const externals = new Map<string, External>();
  const waiters = new Set<Waiter>();
  /** Ids whose herdr:background hold is active. */
  const holds = new Set<string>();
  let ctx: ExtensionContext | undefined;
  let attached = false;
  let unsubscribe: (() => void) | undefined;
  let statusTimer: ReturnType<typeof setInterval> | undefined;
  let lastStatus: string | undefined;
  let herdrActive = false;

  const emit = (channel: string, data: unknown) => {
    try {
      pi.events.emit(channel, data);
    } catch {
      // A failing listener must not break us.
    }
  };

  const snapshot = () =>
    reg.list().map((t) => ({
      id: t.id,
      name: t.name,
      kind: t.kind,
      command: t.command,
      cwd: t.cwd,
      status: t.status,
      ready: t.ready,
      origin: t.origin,
      keep: t.keep,
      willWake: t.origin === "agent" && t.status === "running" && !t.delivered,
      logPath: t.logPath,
    }));

  const updateStatus = () => {
    if (!attached || !ctx?.hasUI) return;
    const s = footerStatus(reg.list());
    if (s === lastStatus) return;
    lastStatus = s;
    ctx.ui.setStatus("bg", s);
  };

  /** Hold herdr:background for every agent job that will wake the agent. */
  const syncHolds = () => {
    if (!attached) return;
    const want = new Set(reg.running().filter((t) => t.origin === "agent" && t.kind === "job" && !t.delivered).map((t) => t.id));
    for (const id of want) {
      if (holds.has(id)) continue;
      holds.add(id);
      emit("herdr:background", { active: true, label: reg.tasks.get(id)?.name ?? id, id: `bg:${id}` });
    }
    for (const id of [...holds]) {
      if (want.has(id)) continue;
      holds.delete(id);
      emit("herdr:background", { active: false, id: `bg:${id}` });
    }
  };

  const refresh = () => {
    updateStatus();
    syncHolds();
    emit("bg:tasks", { tasks: snapshot() });
  };

  // ---- waking the agent ----

  const wakeText = (t: Task, kind: "end" | "ready"): string => {
    if (kind === "ready") {
      return `Background service ${t.name} (${t.id}) is ready${t.readyLine ? `: ${t.readyLine}` : ""}. It keeps running; bg_logs ${t.id} reads its log.`;
    }
    const what = t.kind === "job" ? "Background job" : "Background service";
    return `${what} ${t.name} (${t.id}) ended: ${outcome(t)} after ${runtime(t)}.\n\n${report(t)}`;
  };

  const wake = (t: Task, kind: "end" | "ready") => {
    if (kind === "end") t.delivered = true;
    else t.readyDelivered = true;
    if (!attached) {
      t.pendingWake = kind;
      return;
    }
    t.pendingWake = undefined;
    pi.sendMessage(
      { customType: "pi-bg", content: wakeText(t, kind), display: true, details: { id: t.id, name: t.name, kind, status: t.status } },
      { triggerTurn: true, deliverAs: "followUp" },
    );
  };

  /** Hands an ended or ready task to a waiter; true when one took it. */
  const toWaiter = (t: Task, kind: "end" | "ready"): boolean => {
    for (const w of waiters) {
      const targeted = w.targets.has(t.id) || (w.any && kind === "end" && t.kind === "job");
      if (!targeted) continue;
      if (kind === "end") {
        t.delivered = true;
        w.finished.push(t);
      } else {
        t.readyDelivered = true;
        w.readied.push(t);
      }
      w.resolve("done");
      return true;
    }
    const open = [...waiters].find((w) => !w.silent);
    if (!open) return false;
    if (kind === "end") t.delivered = true;
    else t.readyDelivered = true;
    open.extras.push(kind === "end" ? `${t.name} (${t.id}) ended: ${outcome(t)} after ${runtime(t)}. bg_logs ${t.id} for its output.` : `${t.name} (${t.id}) is ready${t.readyLine ? `: ${t.readyLine}` : ""}.`);
    return true;
  };

  const notifyUser = (t: Task) => {
    const ok = t.status === "done";
    if (ctx?.hasUI) ctx.ui.notify(`bg: ${t.name} ${outcome(t)} after ${runtime(t)}`, ok ? "info" : "warning");
    emit("herdr:notify", { title: `${t.name} ${ok ? "finished" : outcome(t)}`, body: `ran ${runtime(t)}`, sound: "done", unlessFocused: true });
  };

  const onTask = (e: TaskEvent) => {
    const t = e.task;
    if (e.type === "ready" && t.origin === "agent" && !t.readyDelivered) {
      if (!toWaiter(t, "ready")) wake(t, "ready");
    }
    if (e.type === "end") {
      const awaited = [...waiters].some((w) => w.targets.has(t.id));
      if (t.killedBy === "session") t.delivered = true;
      else if (awaited) toWaiter(t, "end");
      else if (t.origin === "user" || t.adopted) notifyUser(t);
      else if (t.killedBy === "agent") t.delivered = true;
      else if (!t.delivered) {
        if (t.killedBy === "user") {
          t.delivered = true;
          if (attached) {
            pi.sendMessage(
              { customType: "pi-bg", content: `The user stopped background task ${t.name} (${t.id}) after ${runtime(t)}.`, display: true, details: { id: t.id, kind: "end", status: t.status } },
              { deliverAs: "nextTurn" },
            );
          }
        } else if (!toWaiter(t, "end")) wake(t, "end");
      }
    }
    refresh();
  };

  // ---- waiting ----

  const waitFor = (
    w: Omit<Waiter, "resolve" | "finished" | "readied" | "externals" | "extras">,
    timeoutMs: number,
    tick: (() => Reason | undefined) | undefined,
  ): { waiter: Waiter; done: Promise<Reason> } => {
    let resolve!: (r: Reason) => void;
    const done = new Promise<Reason>((r) => {
      resolve = r;
    });
    let settled = false;
    const waiter: Waiter = { ...w, finished: [], readied: [], externals: [], extras: [], resolve: () => {} };
    const timer = setTimeout(() => finish("timeout"), timeoutMs);
    const ticker = tick
      ? setInterval(() => {
          const r = tick();
          if (r) finish(r);
        }, 250)
      : undefined;
    function finish(r: Reason) {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (ticker) clearInterval(ticker);
      waiters.delete(waiter);
      resolve(r);
    }
    waiter.resolve = finish;
    waiters.add(waiter);
    return { waiter, done };
  };

  const externalLine = (x: External) => `${x.label} (${x.id}): ${x.state}${x.summary ? ` · ${x.summary}` : ""}`;

  pi.events.on("bg:external", (data) => {
    const d = data as Partial<External> | undefined;
    if (!d?.id || typeof d.id !== "string") return;
    const state = d.state === "done" || d.state === "failed" ? d.state : "running";
    const x: External = { id: d.id, label: d.label || d.id, state, summary: d.summary, updatedAt: Date.now() };
    externals.set(x.id, x);
    if (state !== "running") {
      for (const w of waiters) {
        if (!w.targets.has(x.id)) continue;
        w.externals.push(x);
        w.resolve("done");
      }
    }
  });
  pi.events.on("bg:probe", (data) => {
    (data as { reply?: () => void } | undefined)?.reply?.();
  });

  // ---- lifecycle ----

  pi.on("session_start", async (event, c) => {
    ctx = c;
    attached = true;
    lastStatus = undefined;
    holds.clear();
    if (event.reason !== "reload") reg.forgetEnded();
    if (event.reason === "startup") {
      const adopted = reg.sweep(c.cwd);
      if (adopted.length && c.hasUI) c.ui.notify(`bg: adopted kept service${adopted.length > 1 ? "s" : ""} ${adopted.map((t) => t.name).join(", ")}`, "info");
    }
    unsubscribe?.();
    unsubscribe = reg.subscribe(onTask);
    for (const t of reg.list()) if (t.pendingWake) wake(t, t.pendingWake);
    herdrActive = false;
    emit("herdr:probe", {
      reply: () => {
        herdrActive = true;
      },
    });
    statusTimer = setInterval(updateStatus, 1_000);
    statusTimer.unref?.();
    refresh();
  });

  pi.events.on("herdr:ready", () => {
    herdrActive = true;
    // pi-herdr loaded after us: send the holds again.
    holds.clear();
    syncHolds();
  });

  pi.on("session_shutdown", async (event) => {
    if (statusTimer) clearInterval(statusTimer);
    statusTimer = undefined;
    for (const w of [...waiters]) w.resolve("aborted");
    for (const id of holds) emit("herdr:background", { active: false, id: `bg:${id}` });
    holds.clear();
    if (event.reason !== "reload") await reg.killAll("session");
    unsubscribe?.();
    unsubscribe = undefined;
    attached = false;
    ctx = undefined;
  });

  // ---- tools ----

  pi.registerTool({
    name: "bg_run",
    label: "Background",
    description:
      "Run a shell command in the background, in its own process group, with its output in a log file. kind=job for a finite command whose result you need: you are woken with its outcome when it exits. kind=service for something that keeps running (dev or notebook server, tunnel, watcher): set `ready` to a regex for the line that means it is up; you are woken once when it matches, or if it exits. Jobs and services stop when this pi session ends, except services with keep=true.",
    promptSnippet: "Run long commands (jobs) or servers (services) in the background; wait on them with bg_wait",
    promptGuidelines: [
      "Use bg_run for commands that may take more than a minute (kind=job) and for anything that must keep running (kind=service); plain bash for the rest.",
      "After starting a job, keep doing other useful work. When nothing is left but the job's result, call bg_wait instead of ending your turn; the user can still interrupt it by typing.",
      "Never poll a background task with sleep loops or repeated bg_logs calls: bg_wait or the wake-up message tells you when it ends.",
      "Use keep=true only for a service the user works in themselves (a notebook or dev server they have open) that should outlive this pi session.",
    ],
    parameters: RunParams,
    renderCall(args, theme) {
      const a = args as { command?: string; kind?: string; name?: string };
      const name = a.name || nameFromCommand(a.command ?? "");
      return new Text(`${theme.fg("toolTitle", theme.bold("bg_run"))} ${theme.fg("accent", name)} ${theme.fg("muted", `(${a.kind ?? "?"})`)} ${theme.fg("dim", (a.command ?? "").replace(/\s+/gu, " "))}`, 0, 0);
    },
    async execute(_id, params, _signal, _onUpdate, c) {
      const kind = params.kind as Kind;
      if (params.ready && kind !== "service") throw new Error("`ready` is for services; a job wakes you when it exits.");
      if (params.ready) parsePattern(params.ready);
      if (params.keep && kind !== "service") throw new Error("`keep` is for services.");
      const cwd = params.cwd ? path.resolve(c.cwd, params.cwd.replace(/^~(?=\/|$)/u, process.env.HOME ?? "~")) : c.cwd;
      const task = reg.start({
        command: params.command,
        name: params.name?.trim() || nameFromCommand(params.command),
        kind,
        cwd,
        sessionId: c.sessionManager.getSessionId(),
        origin: "agent",
        ready: params.ready,
        timeoutSec: params.timeout,
        keep: params.keep,
      });
      // A command that fails at once (a typo, a missing file) is reported here rather than as a wake-up.
      const { waiter, done } = waitFor({ targets: new Set([task.id]), any: false, silent: true }, STARTUP_WAIT_MS, undefined);
      await done;
      refresh();
      if (waiter.finished.length) return text(`${task.name} (${task.kind} ${task.id}) ended at once.\n\n${report(task)}`);
      const lines = [`Started ${task.name} (${task.kind} ${task.id}, pid ${task.pid}). Log: ${task.logPath}`];
      if (task.kind === "job") {
        lines.push(`You will be woken when it exits${task.timeoutSec ? ` (killed after ${task.timeoutSec}s)` : ""}. If nothing else is left to do, call bg_wait instead of ending your turn.`);
      } else if (waiter.readied.length) {
        lines.push(`It is ready: ${task.readyLine}`);
      } else if (task.readyPattern) {
        lines.push(`You will be woken once when a log line matches /${task.readyPattern}/, or if it exits. bg_wait ${task.id} waits for that.`);
      } else {
        lines.push("You will be woken if it exits. Set `ready` next time to be told when it is up.");
      }
      if (task.keep) lines.push("It keeps running after this pi session ends.");
      return text(lines.join("\n"));
    },
  });

  pi.registerTool({
    name: "bg_wait",
    label: "Wait",
    description: `Wait inside this turn for a background job to end (or a service to become ready, when named), then get its outcome and the end of its log. Without id, waits for whichever running job ends first. Returns early when the user sends a message, on Esc, or after \`timeout\` seconds (default ${WAIT_DEFAULT_S}); the job keeps running and still wakes you when it ends.`,
    promptSnippet: "Wait for a background job (keeps the turn working)",
    parameters: WaitParams,
    renderCall(args, theme) {
      const a = args as { id?: string };
      return new Text(`${theme.fg("toolTitle", theme.bold("bg_wait"))} ${theme.fg("accent", a.id ? (reg.find(a.id)?.name ?? a.id) : "next job")}`, 0, 0);
    },
    async execute(_id, params, signal, _onUpdate, c) {
      const timeoutS = Math.min(Math.max(1, Math.round(params.timeout ?? WAIT_DEFAULT_S)), WAIT_MAX_S);
      const targets = new Set<string>();
      let any = false;
      if (params.id) {
        const x = externals.get(params.id);
        const t = x ? undefined : reg.find(params.id);
        if (x) {
          if (x.state !== "running") return text(externalLine(x));
          targets.add(x.id);
        } else if (!t) {
          throw new Error(`No task or outside work matches "${params.id}". ${reg.list().length ? `Tasks: ${reg.list().map((k) => `${k.id} ${k.name}`).join(", ")}.` : "No tasks."}`);
        } else if (t.status !== "running") {
          t.delivered = true;
          refresh();
          return text(report(t));
        } else if (t.kind === "service" && t.ready) {
          t.readyDelivered = true;
          return text(report(t));
        } else {
          if (t.kind === "service" && !t.readyPattern) throw new Error(`${t.name} is a service without a ready pattern: there is nothing to wait for until it exits.`);
          targets.add(t.id);
        }
      } else {
        const jobs = reg.running().filter((t) => t.kind === "job");
        if (!jobs.length) {
          const services = reg.running().filter((t) => t.kind === "service");
          return text(`Nothing to wait for: no job is running.${services.length ? ` Services: ${services.map((t) => `${t.name} (${outcome(t)})`).join(", ")}.` : ""}`);
        }
        any = true;
      }
      if (c.hasPendingMessages()) {
        return text("Not waiting: messages are queued for you and arrive when your turn ends. End your turn to read them; running jobs keep going and wake you when they end.");
      }
      const names = () => (any ? reg.running().filter((t) => t.kind === "job") : [...targets].map((id) => reg.tasks.get(id)).filter((t): t is Task => !!t));
      const label = () => {
        const ts = names();
        if (!ts.length) return externals.get([...targets][0] ?? "")?.label ?? "outside work";
        return ts.map((t) => `${t.name} ${runtime(t)}`).join(" · ");
      };
      const started = Date.now();
      const setWorking = () => {
        if (c.hasUI) c.ui.setWorkingMessage(`Waiting on ${label()}… (type to interrupt)`);
      };
      setWorking();
      let ticks = 0;
      const { waiter, done } = waitFor({ targets, any, silent: false }, timeoutS * 1000, () => {
        if (signal?.aborted) return "aborted";
        if (c.hasPendingMessages()) return "message";
        if (++ticks % 4 === 0) setWorking();
        return undefined;
      });
      const reason = await done;
      if (c.hasUI) c.ui.setWorkingMessage();
      refresh();
      const out: string[] = [];
      for (const t of waiter.finished) out.push(report(t));
      for (const t of waiter.readied) out.push(report(t));
      for (const x of waiter.externals) out.push(externalLine(x));
      if (reason !== "done") {
        const still = names().filter((t) => t.status === "running");
        const what = still.length ? still.map((t) => `${t.name} (${t.id}, ${runtime(t)})`).join(", ") : label();
        const why =
          reason === "message"
            ? "Stopped waiting: the user sent a message."
            : reason === "aborted"
              ? "Stopped waiting: interrupted."
              : `Stopped waiting after ${elapsed(Date.now() - started)} (the timeout).`;
        out.push(`${why} Still running: ${what}. It wakes you when it ends; call bg_wait again to keep waiting.`);
      }
      if (waiter.extras.length) out.push(`Also while you waited:\n${waiter.extras.map((e) => `- ${e}`).join("\n")}`);
      return text(out.join("\n\n"));
    },
  });

  pi.registerTool({
    name: "bg_logs",
    label: "Logs",
    description: "Read a background task's log: its status, then the last lines (or the first, or only lines matching `grep`). Without id, lists every task.",
    promptSnippet: "Read a background task's log, or list the tasks",
    parameters: LogsParams,
    async execute(_id, params) {
      if (!params.id) {
        const tasks = reg.list();
        const lines = tasks.map((t) => taskLine(t));
        for (const x of externals.values()) if (x.state === "running") lines.push(`${x.id}  ${x.label}  outside work  running`);
        return text(lines.length ? lines.join("\n") : "No background tasks.");
      }
      const t = reg.find(params.id);
      if (!t) throw new Error(`No task matches "${params.id}".`);
      const n = Math.min(Math.max(1, Math.round(params.lines ?? LOGS_DEFAULT)), LOGS_MAX);
      const lines = params.grep ? grep(t.logPath, parsePattern(params.grep), n) : params.head ? head(t.logPath, n) : tail(t.logPath, n);
      if (t.status !== "running") t.delivered = true;
      const { text: body, dropped } = bounded(lines, LOGS_BYTES);
      const what = params.grep ? `lines matching ${params.grep}` : params.head ? "first lines" : "last lines";
      const shown = lines.length - dropped;
      return text(`${header(t)}\nLog: ${t.logPath}\n\n${shown ? `${shown} ${what}${dropped ? ` (${dropped} more cut for length)` : ""}:\n${body}` : `No ${what}.`}`);
    },
  });

  const stopTask = async (t: Task, by: "agent" | "user") => {
    await reg.kill(t.id, by);
    emit("bg:killed", { id: t.id, command: t.command, cwd: t.cwd });
    refresh();
  };

  pi.registerTool({
    name: "bg_kill",
    label: "Stop",
    description: "Stop a background task: SIGTERM to its process group, then SIGKILL after 3 seconds.",
    promptSnippet: "Stop a background task",
    parameters: KillParams,
    async execute(_id, params) {
      const t = reg.find(params.id);
      if (!t) throw new Error(`No task matches "${params.id}".`);
      if (t.status !== "running") {
        t.delivered = true;
        return text(`${t.name} (${t.id}) already ended: ${outcome(t)} after ${runtime(t)}.`);
      }
      await stopTask(t, "agent");
      const note = marimoNote(t.command);
      const last = tail(t.logPath, 10);
      return text([`Stopped ${t.name} (${t.id}) after ${runtime(t)}.`, note, last.length ? `Last lines:\n${bounded(last, 3_000).text}` : undefined].filter(Boolean).join("\n\n"));
    },
  });

  // ---- /bg ----

  const openLog = async (c: ExtensionContext, t: Task) => {
    if (c.mode !== "tui") {
      c.ui.notify(tail(t.logPath, 20).join("\n") || "(no output)", "info");
      return;
    }
    await c.ui.custom<void>(
      (tui, theme, _kb, done) => new LogViewer(tui as any, theme as any, t, t.status === "running" ? () => void stopTask(t, "user") : undefined, () => done(undefined)),
      { overlay: true, overlayOptions: { anchor: "center", width: "90%", maxHeight: "80%" } },
    );
  };

  const startUserTask = (c: ExtensionContext, command: string) => {
    const t = reg.start({ command, name: nameFromCommand(command), kind: "job", cwd: c.cwd, sessionId: c.sessionManager.getSessionId(), origin: "user" });
    t.delivered = true;
    refresh();
    c.ui.notify(`bg: started ${t.name} (${t.id})`, "info");
    return t;
  };

  pi.registerCommand("bg", {
    description: "Background tasks: list, view logs, stop, rerun (`/bg run <command>`, `/bg kill <id>`, `/bg clear`)",
    getArgumentCompletions: (prefix) => {
      const subs = ["run ", "kill ", "clear"].filter((s) => s.startsWith(prefix));
      return subs.length ? subs.map((s) => ({ value: s, label: s.trim() })) : null;
    },
    handler: async (args, c) => {
      const [sub, ...rest] = args.trim().split(/\s+/u);
      const arg = args.trim().slice((sub ?? "").length).trim();
      if (sub === "run") {
        if (!arg) return c.ui.notify("Usage: /bg run <command>", "warning");
        startUserTask(c, arg);
        return;
      }
      if (sub === "kill") {
        const t = reg.find(rest.join(" "));
        if (!t || t.status !== "running") return c.ui.notify(`No running task matches "${arg}".`, "warning");
        await stopTask(t, "user");
        return c.ui.notify(`bg: stopped ${t.name}`, "info");
      }
      if (sub === "clear") {
        let n = 0;
        for (const t of reg.list()) {
          if (t.status === "running") continue;
          reg.cleared.add(t.id);
          n++;
        }
        refresh();
        return c.ui.notify(n ? `Cleared ${n} finished task${n === 1 ? "" : "s"}.` : "Nothing to clear.", "info");
      }
      const tasks = reg.list().reverse();
      if (!tasks.length) return c.ui.notify("No background tasks. `/bg run <command>` starts one.", "info");
      const labels = tasks.map((t) => taskLine(t));
      const picked = await c.ui.select("Background tasks", labels);
      const t = tasks[labels.indexOf(picked ?? "")];
      if (!t) return;
      const actions = ["View log"];
      if (t.status === "running") actions.push("Stop");
      actions.push("Rerun");
      if (herdrActive) actions.push("Follow in a herdr split");
      actions.push("Copy log path to the editor");
      const action = await c.ui.select(`${t.name}: ${outcome(t)} after ${runtime(t)}`, actions);
      if (action === "View log") await openLog(c, t);
      else if (action === "Stop") {
        await stopTask(t, "user");
        c.ui.notify(`bg: stopped ${t.name}`, "info");
      } else if (action === "Rerun") startUserTask(c, t.command);
      else if (action === "Follow in a herdr split") {
        emit("herdr:split", {
          command: `tail -n 200 -F ${JSON.stringify(t.logPath)}`,
          cwd: t.cwd,
          done: (ok: boolean, message: string) => {
            if (!ok) c.ui.notify(`bg: ${message}`, "warning");
          },
        });
      } else if (action === "Copy log path to the editor") c.ui.pasteToEditor(t.logPath);
    },
  });
}
