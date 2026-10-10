// Text for the footer, lists, tool results and wake-up messages.
import { bounded, tail } from "./log.ts";
import type { Task } from "./registry.ts";

/** `0:45`, `12:03`, `1h05m`. */
export function elapsed(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  if (s < 3600) return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
  const h = Math.floor(s / 3600);
  return `${h}h${String(Math.floor((s % 3600) / 60)).padStart(2, "0")}m`;
}

export function runtime(t: Task, now = Date.now()): string {
  return elapsed((t.endedAt ?? now) - t.startedAt);
}

/** A name from the command when the model gives none: its first words, without `cd x &&` setup. */
export function nameFromCommand(command: string): string {
  const core = command
    .replace(/^\s*(?:cd\s+\S+\s*(?:&&|;)\s*)+/u, "")
    .replace(/^\s*(?:[A-Z_][A-Z0-9_]*=\S*\s+)+/u, "")
    .trim();
  // A loop or group reads better as its start than as its first words (`for i in`).
  const words = /^(?:(?:for|while|until|if|case)\b|[{(])/u.test(core) ? core.replace(/\s+/gu, " ") : core.split(/\s+/u).slice(0, 3).join(" ");
  return (words.length > 28 ? `${words.slice(0, 27)}…` : words) || "task";
}

/** `exit 0`, `exit 1`, `killed`, `timed out`, `signal SIGSEGV`. */
export function outcome(t: Task): string {
  switch (t.status) {
    case "running":
      return t.kind === "service" ? (t.ready ? "ready" : "starting") : "running";
    case "timeout":
      return "timed out";
    case "killed":
      return t.killedBy === "user" ? "stopped by the user" : "stopped";
    default:
      if (t.exitCode !== null && t.exitCode !== undefined) return `exit ${t.exitCode}`;
      return t.signal ? `signal ${t.signal}` : "ended";
  }
}

/** Seconds a finished task stays in the footer. */
export const FOOTER_LINGER_MS = 60_000;
const FOOTER_ITEMS = 4;

/**
 * The footer status (key `bg`): `bg: tests 2:14 · vite ready · lint ✗`. Running jobs first, then
 * services, then what finished in the last minute (✓, ✗, or ■ when stopped). Undefined when empty.
 */
export function footerStatus(tasks: Task[], now = Date.now()): string | undefined {
  const items: string[] = [];
  for (const t of tasks) if (t.status === "running" && t.kind === "job") items.push(`${t.name} ${runtime(t, now)}`);
  for (const t of tasks) {
    if (t.status !== "running" || t.kind !== "service") continue;
    items.push(`${t.name} ${t.ready ? "ready" : t.readyPattern ? "starting" : "up"}${t.keep ? " (kept)" : ""}`);
  }
  for (const t of tasks) {
    if (t.status === "running" || !t.endedAt || now - t.endedAt > FOOTER_LINGER_MS) continue;
    const mark = t.status === "done" ? "✓" : t.status === "killed" ? "■" : "✗";
    items.push(`${t.name} ${mark}`);
  }
  if (!items.length) return undefined;
  const shown = items.slice(0, FOOTER_ITEMS);
  if (items.length > FOOTER_ITEMS) shown.push(`+${items.length - FOOTER_ITEMS}`);
  return `bg: ${shown.join(" · ")}`;
}

/** One line per task for `bg_logs` without an id and for `/bg`. */
export function taskLine(t: Task, now = Date.now()): string {
  const bits = [t.id, t.name, t.kind, `${outcome(t)} ${runtime(t, now)}`];
  if (t.keep) bits.push("kept");
  if (t.origin === "user") bits.push("started by the user");
  return bits.join("  ");
}

export function header(t: Task, now = Date.now()): string {
  const bits = [`${t.name} (${t.kind} ${t.id})`, `${outcome(t)} after ${runtime(t, now)}`];
  if (t.status === "running") bits[1] = `${outcome(t)} for ${runtime(t, now)}`;
  if (t.pid) bits.push(`pid ${t.pid}`);
  bits.push(`cwd ${t.cwd}`);
  return bits.join(" · ");
}

/** A finished (or ready) task with its log's last lines, bounded. */
export function report(t: Task, lines = 30, maxBytes = 6_000, now = Date.now()): string {
  const out = [header(t, now)];
  if (t.status === "running" && t.ready && t.readyLine) out.push(`ready: ${t.readyLine}`);
  const log = tail(t.logPath, lines);
  if (log.length) {
    const { text, dropped } = bounded(log, maxBytes);
    out.push("", `Last ${log.length - dropped} lines of ${t.logPath}:`, text);
  } else out.push("", `No output (${t.logPath}).`);
  return out.join("\n");
}

/** A note for commands that drove a marimo kernel: killing the client does not stop the cell. */
export function marimoNote(command: string): string | undefined {
  if (!/execute-code\.sh|marimo\s+pair\s+execute|marimo\._code_mode/u.test(command)) return undefined;
  return "This command drove a marimo kernel through marimo-pair. Stopping it does not stop the cells it started: they keep running in the kernel until they finish or are interrupted (marimo's /api/kernel/interrupt, or the stop button in the notebook).";
}
