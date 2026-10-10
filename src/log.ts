// Reading task logs: bounded tails, heads and greps of files that may be large and still growing.
// Lines are cleaned for display: ANSI escapes dropped, a carriage-return progress line kept in its
// final form, very long lines cut.
import fs from "node:fs";

/** How much of a log a tail reads. */
const TAIL_BYTES = 512 * 1024;
/** How much of a log a grep scans (its end). */
const GREP_BYTES = 8 * 1024 * 1024;
/** Longest line returned. */
export const MAX_LINE = 400;

// CSI, OSC (BEL or ST terminated), charset selection (`\x1b(B` from `tput sgr0`), keypad modes,
// and other two-character escapes.
const ANSI = /\x1b\[[0-?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b[()*+][0-9A-Za-z@]|\x1b[=>]|\x1b[@-Z\\-_]/gu;
/** The longest partial line a follower keeps (a progress bar redrawn with \r and no \n). */
const MAX_PARTIAL = 64 * 1024;

export function cleanLine(line: string): string {
  let l = line.replace(ANSI, "");
  // A progress bar rewrites its line with \r: keep what was drawn last.
  const cr = l.lastIndexOf("\r", l.length - 2);
  if (cr >= 0) l = l.slice(cr + 1);
  l = l.replace(/\r$/u, "");
  return l.length > MAX_LINE ? `${l.slice(0, MAX_LINE)}…` : l;
}

function readRange(path: string, start: number, length: number): string {
  if (length <= 0) return "";
  const fd = fs.openSync(path, "r");
  try {
    const buf = Buffer.alloc(length);
    const n = fs.readSync(fd, buf, 0, length, start);
    return buf.subarray(0, n).toString("utf8");
  } finally {
    fs.closeSync(fd);
  }
}

export function logSize(path: string): number {
  try {
    return fs.statSync(path).size;
  } catch {
    return 0;
  }
}

/** The last `bytes` of the file as lines, the first dropped when it was cut mid-line. */
function lastLines(path: string, bytes: number): { lines: string[]; truncated: boolean } {
  const size = logSize(path);
  const start = Math.max(0, size - bytes);
  const text = readRange(path, start, size - start);
  const lines = text.split("\n");
  // The first line was cut mid-way, unless it is the only one (output redrawn with \r, no \n at all).
  if (start > 0 && lines.length > 1) lines.shift();
  if (lines.length && lines[lines.length - 1] === "") lines.pop();
  return { lines, truncated: start > 0 };
}

export function tail(path: string, n: number): string[] {
  return lastLines(path, TAIL_BYTES).lines.slice(-n).map(cleanLine);
}

export function head(path: string, n: number): string[] {
  const text = readRange(path, 0, Math.min(logSize(path), TAIL_BYTES));
  const lines = text.split("\n");
  if (lines.length && lines[lines.length - 1] === "") lines.pop();
  return lines.slice(0, n).map(cleanLine);
}

/** The last `n` lines matching `re` among the log's last 8 MB. */
export function grep(path: string, re: RegExp, n: number): string[] {
  const out: string[] = [];
  for (const raw of lastLines(path, GREP_BYTES).lines) {
    const line = cleanLine(raw);
    re.lastIndex = 0;
    if (re.test(line)) out.push(line);
  }
  return out.slice(-n);
}

/** Lines added since `offset`, for watching a growing log. Keeps a partial last line for later. */
export class LogFollower {
  private offset = 0;
  private partial = "";

  constructor(private readonly path: string) {}

  read(): string[] {
    const size = logSize(this.path);
    if (size < this.offset) {
      this.offset = 0;
      this.partial = "";
    }
    if (size === this.offset) return [];
    const chunk = Math.min(size - this.offset, 1024 * 1024);
    const text = this.partial + readRange(this.path, this.offset, chunk);
    this.offset += chunk;
    const lines = text.split("\n");
    // A line that never ends (a \r progress bar) is kept short: only its latest drawing matters.
    this.partial = (lines.pop() ?? "").slice(-MAX_PARTIAL);
    return lines.map(cleanLine);
  }

  /** Whatever is left, including a last line with no newline (after the process ended). */
  flush(): string[] {
    const lines = this.read();
    if (this.partial) {
      lines.push(cleanLine(this.partial));
      this.partial = "";
    }
    return lines;
  }
}

/** Joins lines and keeps the result under `maxBytes`, dropping the oldest lines first. */
export function bounded(lines: string[], maxBytes: number): { text: string; dropped: number } {
  let total = 0;
  let i = lines.length;
  while (i > 0) {
    const len = Buffer.byteLength(lines[i - 1] ?? "") + 1;
    if (total + len > maxBytes) break;
    total += len;
    i--;
  }
  return { text: lines.slice(i).join("\n"), dropped: i };
}
