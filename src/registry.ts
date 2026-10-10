// The tasks and their processes. One registry per pi process, kept on globalThis so that tasks
// outlive `/reload`. A reload loads this module again, so the new code builds a new Registry that
// shares the old one's maps (tasks, processes, listeners...) and becomes its successor: process-exit
// handlers and timers started by the old instance hand over to the newest one.
//
// Each task runs `bash -c <command>` in its own process group, with stdout and stderr written
// straight to a log file, so output keeps flowing whatever pi does.
//
// `state/<pid>.json` (beside the logs) lists one pi process's running tasks, so a later pi can kill
// what a crashed one left behind and adopt services started with `keep`. Each process writes only
// its own file; a process that quits leaves its kept services in it, marked released.
import { type ChildProcess, execFileSync, spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { LogFollower, logSize } from "./log.ts";

export type Kind = "job" | "service";
export type Status = "running" | "done" | "failed" | "killed" | "timeout";
export type Origin = "agent" | "user";

export interface Task {
  id: string;
  name: string;
  kind: Kind;
  command: string;
  cwd: string;
  logPath: string;
  pid?: number;
  startedAt: number;
  endedAt?: number;
  exitCode?: number | null;
  signal?: string | null;
  status: Status;
  /** A service whose `ready` pattern has matched. */
  ready: boolean;
  readyPattern?: string;
  timeoutSec?: number;
  /** A service left running when pi exits, for later sessions to adopt. */
  keep: boolean;
  origin: Origin;
  /** Who stopped it, when someone did. */
  killedBy?: "agent" | "user" | "session" | "timeout";
  /** The agent has (or is about to get) this task's outcome: no wake-up is owed. */
  delivered: boolean;
  /** The agent has been told the service is ready. */
  readyDelivered: boolean;
  /** A kept service started by an earlier pi: no child handle, liveness is polled. */
  adopted?: boolean;
  /** The line that matched `ready`. */
  readyLine?: string;
  /** The shell exited but processes it started are still running in its group. */
  strays?: boolean;
}

export type TaskEvent = { type: "start" | "ready" | "end" | "change"; task: Task };

export interface StartOptions {
  command: string;
  name: string;
  kind: Kind;
  cwd: string;
  sessionId: string;
  origin: Origin;
  ready?: string;
  timeoutSec?: number;
  keep?: boolean;
}

interface StateEntry {
  id: string;
  name: string;
  kind: Kind;
  command: string;
  cwd: string;
  logPath: string;
  pid: number;
  startedAt: number;
  keep: boolean;
  ready: boolean;
  readyPattern?: string;
  /** The owning pi quit and left this kept service for a later one. */
  released?: boolean;
  /** Only in the legacy single state.json. */
  owner?: number;
}

const POLL_MS = 500;
/** A running task's log is cut back to its last megabyte when it passes this size. */
export const MAX_LOG_BYTES = 64 * 1024 * 1024;
const KEEP_TAIL_BYTES = 1024 * 1024;
/** How often (in polls) running logs are checked against the cap. */
const SIZE_CHECK_POLLS = 20;
const KILL_GRACE_MS = 3_000;
const KEEP_LOG_DAYS = 7;

export function bgDir(): string {
  return process.env.PI_BG_DIR || path.join(os.homedir(), ".pi", "agent", "bg");
}

function stateDir(): string {
  return path.join(bgDir(), "state");
}

function shell(): string {
  return fs.existsSync("/bin/bash") ? "/bin/bash" : "/bin/sh";
}

/** Whether any process of the group led by `pid` is still alive. */
export function groupAlive(pid: number): boolean {
  try {
    process.kill(-pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === "EPERM";
  }
}

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === "EPERM";
  }
}

/** Signals a whole process group. Never a bare pid: a reused pid could belong to anything. */
function signalGroup(pgid: number, signal: NodeJS.Signals): void {
  try {
    process.kill(-pgid, signal);
  } catch {
    // Already gone.
  }
}

const squash = (s: string) => s.replace(/\s+/gu, " ").trim();

/**
 * Whether `pid` still runs the task's command (`bash -c <command>`, or the command itself when bash
 * exec'd into it), so a pid reused by an unrelated process is never signalled.
 */
export function stillOurs(pid: number, command: string): boolean {
  let line: string;
  try {
    line = execFileSync("ps", ["-ww", "-o", "command=", "-p", String(pid)], { encoding: "utf8", timeout: 2_000 });
  } catch {
    return false;
  }
  const want = squash(command).slice(0, 40);
  return want.length > 0 && squash(line).includes(want);
}

/** A pattern from the model: `/src/flags`, or a plain regex matched case-insensitively. */
export function parsePattern(pattern: string): RegExp {
  const m = /^\/(.+)\/([a-z]*)$/su.exec(pattern);
  return m ? new RegExp(m[1] as string, (m[2] ?? "").replace(/[gy]/gu, "")) : new RegExp(pattern, "i");
}

export class Registry {
  readonly tasks = new Map<string, Task>();
  private readonly procs = new Map<string, ChildProcess>();
  private readonly followers = new Map<string, { follower: LogFollower; re: RegExp }>();
  private readonly timeouts = new Map<string, ReturnType<typeof setTimeout>>();
  private readonly listeners = new Set<(e: TaskEvent) => void>();
  /** Process groups of ended tasks that still have members, killed when the session ends. */
  private readonly strays = new Set<number>();
  private poller: ReturnType<typeof setInterval> | undefined;
  private polls = 0;
  /** The registry that took over after a reload; handlers started here hand over to it. */
  private successor: Registry | undefined;
  /** Ended tasks hidden from lists (`/tasks clear`, `x` in the dialog). */
  readonly cleared = new Set<string>();

  /** The newest registry (this one, or the one that took over after a reload). */
  private latest(): Registry {
    let r: Registry = this;
    while (r.successor && r.successor !== r) r = r.successor;
    return r;
  }

  /**
   * Takes over the state of a registry built by an earlier load of this module (before a reload):
   * the same maps, so its pending process-exit handlers and timers keep working on them.
   */
  adopt(old: unknown): void {
    const o = old as Record<string, unknown>;
    const self = this as unknown as Record<string, unknown>;
    for (const key of ["tasks", "procs", "followers", "timeouts"]) if (o[key] instanceof Map) self[key] = o[key];
    for (const key of ["listeners", "cleared", "strays"]) if (o[key] instanceof Set) self[key] = o[key];
    // One poller: the new code's.
    if (o.poller) clearInterval(o.poller as ReturnType<typeof setInterval>);
    o.poller = undefined;
    o.successor = this;
    if (this.running().length) this.ensurePoller();
  }

  subscribe(fn: (e: TaskEvent) => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  private emit(type: TaskEvent["type"], task: Task): void {
    for (const fn of [...this.listeners]) {
      try {
        fn({ type, task });
      } catch {
        // A listener must not break the registry.
      }
    }
  }

  list(): Task[] {
    return [...this.tasks.values()].filter((t) => !this.cleared.has(t.id)).sort((a, b) => a.startedAt - b.startedAt);
  }

  running(): Task[] {
    return [...this.tasks.values()].filter((t) => t.status === "running").sort((a, b) => a.startedAt - b.startedAt);
  }

  /** By id, by id prefix, or by name (the most recent task with it). */
  find(ref: string): Task | undefined {
    const r = ref.trim();
    if (!r) return undefined;
    const exact = this.tasks.get(r);
    if (exact) return exact;
    const all = [...this.tasks.values()].sort((a, b) => b.startedAt - a.startedAt);
    const byName = all.find((t) => t.name === r);
    if (byName) return byName;
    const byPrefix = all.filter((t) => t.id.startsWith(r));
    return byPrefix.length === 1 ? byPrefix[0] : undefined;
  }

  private newId(): string {
    for (;;) {
      const id = randomBytes(3).toString("hex").slice(0, 5);
      if (!this.tasks.has(id) && !/^\d+$/u.test(id)) return id;
    }
  }

  start(o: StartOptions): Task {
    const id = this.newId();
    const dir = path.join(bgDir(), o.sessionId || "no-session");
    fs.mkdirSync(dir, { recursive: true });
    const logPath = path.join(dir, `${id}.log`);
    const re = o.ready ? parsePattern(o.ready) : undefined;
    const task: Task = {
      id,
      name: o.name,
      kind: o.kind,
      command: o.command,
      cwd: o.cwd,
      logPath,
      startedAt: Date.now(),
      status: "running",
      ready: false,
      readyPattern: o.ready,
      timeoutSec: o.kind === "job" ? o.timeoutSec : undefined,
      keep: o.kind === "service" && Boolean(o.keep),
      origin: o.origin,
      delivered: false,
      readyDelivered: false,
    };
    const fd = fs.openSync(logPath, "a");
    let child: ChildProcess;
    try {
      child = spawn(shell(), ["-c", o.command], {
        cwd: o.cwd,
        detached: true,
        stdio: ["ignore", fd, fd],
        env: { ...process.env, PI_BG_TASK_ID: id },
      });
    } finally {
      fs.closeSync(fd);
    }
    task.pid = child.pid;
    this.tasks.set(id, task);
    this.procs.set(id, child);
    child.unref();
    child.on("error", (err) => {
      fs.appendFileSync(logPath, `\n[pi-bg] could not start: ${err.message}\n`);
      this.latest().finish(id, 127, null);
    });
    child.on("exit", (code, signal) => this.latest().finish(id, code, signal));
    if (re) this.followers.set(id, { follower: new LogFollower(logPath), re });
    if (task.timeoutSec && task.timeoutSec > 0) {
      const t = setTimeout(() => void this.latest().kill(id, "timeout"), task.timeoutSec * 1000);
      t.unref?.();
      this.timeouts.set(id, t);
    }
    this.ensurePoller();
    this.persist();
    this.emit("start", task);
    return task;
  }

  private ensurePoller(): void {
    if (this.poller) return;
    this.poller = setInterval(() => this.poll(), POLL_MS);
    this.poller.unref?.();
  }

  /** Ready patterns, the liveness of adopted services, and the log size cap. */
  poll(): void {
    if (++this.polls % SIZE_CHECK_POLLS === 0) this.capLogs();
    for (const [id, w] of this.followers) {
      const task = this.tasks.get(id);
      if (!task || task.status !== "running" || task.ready) {
        this.followers.delete(id);
        continue;
      }
      for (const line of w.follower.read()) {
        w.re.lastIndex = 0;
        if (w.re.test(line)) {
          this.markReady(task, line);
          break;
        }
      }
    }
    for (const task of this.tasks.values()) {
      if (task.adopted && task.status === "running" && task.pid && !groupAlive(task.pid)) this.finish(task.id, null, null);
    }
    if (!this.followers.size && !this.running().length) {
      if (this.poller) clearInterval(this.poller);
      this.poller = undefined;
    }
  }

  /**
   * Cuts a running task's log back to its last megabyte once it passes 64 MB. The cut tail goes back
   * through an appending descriptor, so a line the task writes meanwhile lands beside it instead of
   * being overwritten; a ready pattern's follower starts over at the cut.
   */
  capLogs(max = MAX_LOG_BYTES, keep = KEEP_TAIL_BYTES): void {
    for (const t of this.tasks.values()) {
      if (t.status !== "running") continue;
      const size = logSize(t.logPath);
      if (size <= max) continue;
      try {
        const fd = fs.openSync(t.logPath, "r");
        let text: string;
        try {
          const buf = Buffer.alloc(Math.min(keep, size));
          fs.readSync(fd, buf, 0, buf.length, size - buf.length);
          text = buf.toString("utf8");
        } finally {
          fs.closeSync(fd);
        }
        const tailStart = text.indexOf("\n") + 1;
        fs.truncateSync(t.logPath, 0);
        fs.appendFileSync(t.logPath, `[pi-bg] log cut at ${Math.round(max / 1024 / 1024)} MB; earlier output dropped\n${text.slice(tailStart)}`);
      } catch {
        // Leave it; the next check tries again.
      }
    }
  }

  private markReady(task: Task, line: string): void {
    if (task.ready) return;
    task.ready = true;
    task.readyLine = line;
    this.followers.delete(task.id);
    this.persist();
    this.emit("ready", task);
  }

  private finish(id: string, code: number | null, signal: NodeJS.Signals | null): void {
    const task = this.tasks.get(id);
    if (!task || task.status !== "running") return;
    // Read the last of the log before deciding about readiness, in case the line came at the end.
    const w = this.followers.get(id);
    if (w && !task.ready) {
      for (const line of w.follower.flush()) {
        w.re.lastIndex = 0;
        if (w.re.test(line)) {
          task.ready = true;
          task.readyLine = line;
          break;
        }
      }
    }
    this.followers.delete(id);
    const t = this.timeouts.get(id);
    if (t) clearTimeout(t);
    this.timeouts.delete(id);
    this.procs.delete(id);
    task.endedAt = Date.now();
    task.exitCode = code;
    task.signal = signal;
    // A command that exited 0 on its own finished, even if a stop or timeout raced it.
    task.status = code === 0 ? "done" : task.killedBy === "timeout" ? "timeout" : task.killedBy ? "killed" : "failed";
    // The shell is gone; anything it left running in its group (`npm run dev &`) is killed at session end.
    if (task.pid && !task.adopted && groupAlive(task.pid)) {
      task.strays = true;
      this.strays.add(task.pid);
    }
    this.persist();
    this.emit("end", task);
  }

  /** SIGTERM to the task's process group, then SIGKILL after a grace period. Resolves once it ended. */
  async kill(id: string, by: NonNullable<Task["killedBy"]>, graceMs = KILL_GRACE_MS): Promise<void> {
    const task = this.tasks.get(id);
    if (!task || task.status !== "running" || !task.pid) return;
    task.killedBy ??= by;
    const pid = task.pid;
    signalGroup(pid, "SIGTERM");
    const deadline = Date.now() + graceMs;
    while (Date.now() < deadline && groupAlive(pid)) await new Promise((r) => setTimeout(r, 50));
    const forced = groupAlive(pid);
    if (forced) signalGroup(pid, "SIGKILL");
    if (task.status === "running") {
      // The shell's exit event normally lands first; adopted tasks have none.
      const until = Date.now() + 1_000;
      while (task.status === "running" && Date.now() < until && this.procs.has(id)) await new Promise((r) => setTimeout(r, 20));
      if (task.status === "running") this.finish(id, null, forced ? "SIGKILL" : "SIGTERM");
    }
    this.strays.delete(pid);
  }

  /** Kill every running task except kept services, and what ended tasks left behind; used when the session ends. */
  async killAll(by: NonNullable<Task["killedBy"]>, graceMs = 1_000): Promise<void> {
    const strays = [...this.strays];
    this.strays.clear();
    for (const pgid of strays) signalGroup(pgid, "SIGTERM");
    await Promise.all(this.running().filter((t) => !t.keep).map((t) => this.kill(t.id, by, graceMs)));
    for (const pgid of strays) if (groupAlive(pgid)) signalGroup(pgid, "SIGKILL");
  }

  /** Forget ended tasks: used when the session changes. Kept services stay, owing the new session nothing. */
  forgetEnded(): void {
    for (const [id, t] of this.tasks) {
      if (t.status !== "running") this.tasks.delete(id);
      else if (t.keep) {
        t.delivered = true;
        t.readyDelivered = true;
        t.origin = "user";
      }
    }
  }

  // ---- state files ----

  private ownStatePath(): string {
    return path.join(stateDir(), `${process.pid}.json`);
  }

  private static readEntries(file: string): StateEntry[] {
    try {
      const data = JSON.parse(fs.readFileSync(file, "utf8"));
      return Array.isArray(data) ? data : [];
    } catch {
      return [];
    }
  }

  private static writeEntries(file: string, entries: StateEntry[]): void {
    try {
      if (!entries.length) {
        fs.rmSync(file, { force: true });
        return;
      }
      fs.mkdirSync(path.dirname(file), { recursive: true });
      const tmp = `${file}.${process.pid}.tmp`;
      fs.writeFileSync(tmp, `${JSON.stringify(entries, null, 2)}\n`);
      fs.renameSync(tmp, file);
    } catch {
      // Best effort: losing it only loses crash cleanup and adoption.
    }
  }

  private entryOf(t: Task, released = false): StateEntry {
    return {
      id: t.id,
      name: t.name,
      kind: t.kind,
      command: t.command,
      cwd: t.cwd,
      logPath: t.logPath,
      pid: t.pid as number,
      startedAt: t.startedAt,
      keep: t.keep,
      ready: t.ready,
      readyPattern: t.readyPattern,
      ...(released ? { released: true } : {}),
    };
  }

  /** Rewrites this process's state file: its running tasks. */
  persist(): void {
    Registry.writeEntries(
      this.ownStatePath(),
      this.running()
        .filter((t) => t.pid)
        .map((t) => this.entryOf(t)),
    );
  }

  /** The session ends for good (quit): leave kept services in the state file, released for a later pi. */
  release(): void {
    Registry.writeEntries(
      this.ownStatePath(),
      this.running()
        .filter((t) => t.pid && t.keep)
        .map((t) => this.entryOf(t, true)),
    );
  }

  /**
   * At startup: kill what crashed pi processes left running, adopt kept services under `cwd`, and
   * delete logs older than a week that nothing references. A pid is only signalled or adopted while
   * it still runs the task's command.
   */
  sweep(cwd: string): Task[] {
    const adopted: Task[] = [];
    const referenced: StateEntry[] = [];
    const inside = (a: string, b: string) => a === b || a.startsWith(`${b}${path.sep}`);
    const files: { file: string; owner: number; entries: StateEntry[] }[] = [];
    try {
      for (const name of fs.readdirSync(stateDir())) {
        const m = /^(\d+)\.json$/u.exec(name);
        if (m) files.push({ file: path.join(stateDir(), name), owner: Number(m[1]), entries: Registry.readEntries(path.join(stateDir(), name)) });
      }
    } catch {
      // No state yet.
    }
    // The single state.json of earlier versions.
    const legacy = path.join(bgDir(), "state.json");
    if (fs.existsSync(legacy)) {
      const byOwner = new Map<number, StateEntry[]>();
      for (const e of Registry.readEntries(legacy)) byOwner.set(e.owner ?? 0, [...(byOwner.get(e.owner ?? 0) ?? []), e]);
      for (const [owner, entries] of byOwner) files.push({ file: "", owner, entries });
      fs.rmSync(legacy, { force: true });
    }
    for (const { file, owner, entries } of files) {
      if (owner === process.pid) continue;
      const ownerAlive = owner > 0 && pidAlive(owner);
      const left: StateEntry[] = [];
      for (const e of entries) {
        if (this.tasks.has(e.id)) continue;
        // A live pi still owns it, unless it quit and released it.
        if (ownerAlive && !e.released) {
          left.push(e);
          continue;
        }
        if (!groupAlive(e.pid) || !stillOurs(e.pid, e.command)) continue;
        if (!e.keep) {
          signalGroup(e.pid, "SIGTERM");
          const pgid = e.pid;
          setTimeout(() => {
            if (groupAlive(pgid) && stillOurs(pgid, e.command)) signalGroup(pgid, "SIGKILL");
          }, KILL_GRACE_MS).unref?.();
          continue;
        }
        if (!inside(e.cwd, cwd) && !inside(cwd, e.cwd)) {
          left.push({ ...e, released: true });
          continue;
        }
        const task: Task = {
          id: this.tasks.has(e.id) ? this.newId() : e.id,
          name: e.name,
          kind: e.kind,
          command: e.command,
          cwd: e.cwd,
          logPath: e.logPath,
          pid: e.pid,
          startedAt: e.startedAt,
          status: "running",
          ready: e.ready,
          readyPattern: e.readyPattern,
          keep: true,
          origin: "user",
          delivered: true,
          readyDelivered: true,
          adopted: true,
        };
        this.tasks.set(task.id, task);
        if (task.readyPattern && !task.ready) {
          try {
            this.followers.set(task.id, { follower: new LogFollower(task.logPath), re: parsePattern(task.readyPattern) });
          } catch {
            // A pattern that no longer parses: it just stays "starting".
          }
        }
        adopted.push(task);
      }
      referenced.push(...left);
      const target = file || path.join(stateDir(), `${owner}.json`);
      if (owner > 0 && (file || left.length)) Registry.writeEntries(target, left);
    }
    this.persist();
    if (adopted.length) this.ensurePoller();
    this.cleanOldLogs(referenced);
    return adopted;
  }

  private cleanOldLogs(referenced: StateEntry[]): void {
    const cutoff = Date.now() - KEEP_LOG_DAYS * 86_400_000;
    const inUse = new Set([...referenced.map((e) => path.dirname(e.logPath)), ...[...this.tasks.values()].map((t) => path.dirname(t.logPath))]);
    let dirs: fs.Dirent[];
    try {
      dirs = fs.readdirSync(bgDir(), { withFileTypes: true });
    } catch {
      return;
    }
    for (const d of dirs) {
      if (!d.isDirectory() || d.name === "state") continue;
      const p = path.join(bgDir(), d.name);
      if (inUse.has(p)) continue;
      try {
        if (fs.statSync(p).mtimeMs < cutoff) fs.rmSync(p, { recursive: true, force: true });
      } catch {
        // Ignore.
      }
    }
  }
}

const KEY = Symbol.for("pi-bg.registry.v1");

/** The registry of this pi process, shared across `/reload` (see the top of this file). */
export function registry(): Registry {
  const g = globalThis as unknown as Record<symbol, unknown>;
  const current = g[KEY];
  if (current instanceof Registry) return current;
  const next = new Registry();
  if (current) next.adopt(current);
  g[KEY] = next;
  return next;
}
