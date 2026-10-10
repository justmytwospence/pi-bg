// The tasks and their processes. One registry per pi process, kept on globalThis so that tasks
// outlive `/reload` (which replaces the extension's module instance): the new instance picks the
// registry up again. Each task runs `bash -c <command>` in its own process group, with stdout and
// stderr written straight to a log file, so output keeps flowing whatever pi does.
//
// state.json (beside the logs) lists the running tasks of every pi process on this machine, so a
// later pi can kill what a crashed one left behind and adopt services started with `keep`.
import { type ChildProcess, spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { LogFollower } from "./log.ts";

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
  /** A wake-up that could not be sent (no session attached); sent at the next session start. */
  pendingWake?: "end" | "ready";
  /** A kept service started by an earlier pi: no child handle, liveness is polled. */
  adopted?: boolean;
  /** The line that matched `ready`. */
  readyLine?: string;
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
  owner: number;
}

const POLL_MS = 500;
const KILL_GRACE_MS = 3_000;
const KEEP_LOG_DAYS = 7;

export function bgDir(): string {
  return process.env.PI_BG_DIR || path.join(os.homedir(), ".pi", "agent", "bg");
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

function signalGroup(pid: number, signal: NodeJS.Signals): void {
  try {
    process.kill(-pid, signal);
  } catch {
    try {
      process.kill(pid, signal);
    } catch {
      // Already gone.
    }
  }
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
  private poller: ReturnType<typeof setInterval> | undefined;
  /** Ended tasks hidden from lists (`/bg clear`). */
  readonly cleared = new Set<string>();

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

  changed(task: Task): void {
    this.emit("change", task);
  }

  list(): Task[] {
    return [...this.tasks.values()].filter((t) => !this.cleared.has(t.id)).sort((a, b) => a.startedAt - b.startedAt);
  }

  running(): Task[] {
    return this.list().filter((t) => t.status === "running");
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
      this.finish(id, 127, null);
    });
    child.on("exit", (code, signal) => this.finish(id, code, signal));
    if (re) this.followers.set(id, { follower: new LogFollower(logPath), re });
    if (task.timeoutSec && task.timeoutSec > 0) {
      const t = setTimeout(() => void this.kill(id, "timeout"), task.timeoutSec * 1000);
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

  /** Ready patterns, and the liveness of adopted services. */
  poll(): void {
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
    if (!this.followers.size && ![...this.tasks.values()].some((t) => t.adopted && t.status === "running")) {
      if (this.poller) clearInterval(this.poller);
      this.poller = undefined;
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
    task.status = task.killedBy === "timeout" ? "timeout" : task.killedBy ? "killed" : code === 0 ? "done" : "failed";
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
    if (groupAlive(pid)) signalGroup(pid, "SIGKILL");
    if (task.status === "running") {
      // The shell's exit event normally lands first; adopted tasks have none.
      const until = Date.now() + 1_000;
      while (task.status === "running" && Date.now() < until && this.procs.has(id)) await new Promise((r) => setTimeout(r, 20));
      if (task.status === "running") this.finish(id, null, "SIGKILL");
    }
  }

  /** Kill every running task except kept services; used when the session ends. */
  async killAll(by: NonNullable<Task["killedBy"]>, graceMs = 1_000): Promise<void> {
    await Promise.all(this.running().filter((t) => !t.keep).map((t) => this.kill(t.id, by, graceMs)));
  }

  /** Forget ended tasks (and kept services handed to a later pi): used when the session changes. */
  forgetEnded(): void {
    for (const [id, t] of this.tasks) if (t.status !== "running") this.tasks.delete(id);
  }

  // ---- state.json ----

  private statePath(): string {
    return path.join(bgDir(), "state.json");
  }

  private readState(): StateEntry[] {
    try {
      const data = JSON.parse(fs.readFileSync(this.statePath(), "utf8"));
      return Array.isArray(data) ? data : [];
    } catch {
      return [];
    }
  }

  private writeState(entries: StateEntry[]): void {
    try {
      fs.mkdirSync(bgDir(), { recursive: true });
      const tmp = `${this.statePath()}.${process.pid}.tmp`;
      fs.writeFileSync(tmp, `${JSON.stringify(entries, null, 2)}\n`);
      fs.renameSync(tmp, this.statePath());
    } catch {
      // Best effort: losing it only loses crash cleanup and adoption.
    }
  }

  /** Rewrites this process's entries in state.json, leaving other pi processes' alone. */
  persist(): void {
    const others = this.readState().filter((e) => e.owner !== process.pid && !this.tasks.has(e.id));
    const mine: StateEntry[] = [...this.tasks.values()]
      .filter((t) => t.status === "running" && t.pid)
      .map((t) => ({
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
        owner: process.pid,
      }));
    this.writeState([...others, ...mine]);
  }

  /**
   * At startup: kill what crashed pi processes left running, adopt kept services under `cwd`,
   * and delete logs older than a week that nothing references.
   */
  sweep(cwd: string): Task[] {
    const adopted: Task[] = [];
    const keepEntries: StateEntry[] = [];
    for (const e of this.readState()) {
      if (this.tasks.has(e.id)) continue;
      const ownerAlive = e.owner !== process.pid && pidAlive(e.owner);
      if (ownerAlive) {
        keepEntries.push(e);
        continue;
      }
      if (!groupAlive(e.pid)) continue;
      if (!e.keep) {
        signalGroup(e.pid, "SIGTERM");
        continue;
      }
      const inside = (a: string, b: string) => a === b || a.startsWith(`${b}${path.sep}`);
      if (!inside(e.cwd, cwd) && !inside(cwd, e.cwd)) {
        keepEntries.push(e);
        continue;
      }
      const task: Task = {
        id: e.id,
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
      adopted.push(task);
    }
    this.writeState(keepEntries);
    this.persist();
    if (adopted.length) this.ensurePoller();
    this.cleanOldLogs(keepEntries);
    return adopted;
  }

  private cleanOldLogs(keepEntries: StateEntry[]): void {
    const cutoff = Date.now() - KEEP_LOG_DAYS * 86_400_000;
    const inUse = new Set([...keepEntries.map((e) => path.dirname(e.logPath)), ...[...this.tasks.values()].map((t) => path.dirname(t.logPath))]);
    let dirs: fs.Dirent[];
    try {
      dirs = fs.readdirSync(bgDir(), { withFileTypes: true });
    } catch {
      return;
    }
    for (const d of dirs) {
      if (!d.isDirectory()) continue;
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

/** The registry of this pi process, shared across `/reload`. */
export function registry(): Registry {
  const g = globalThis as unknown as Record<symbol, Registry | undefined>;
  g[KEY] ??= new Registry();
  return g[KEY] as Registry;
}
