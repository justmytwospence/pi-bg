// `/bg`'s log view: an overlay following one task's log. ↑↓ (or j/k), PgUp/PgDn, Home/End scroll
// (scrolling to the end follows again); `x` twice stops a running task; Esc or q closes.
import { type Component, type TUI, matchesKey, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { header } from "./format.ts";
import { tail } from "./log.ts";
import type { Task } from "./registry.ts";

const HEIGHT_PCT = 80;
/** Border, two header lines, two rules, footer, border. */
const CHROME = 7;
const MAX_LINES = 5_000;

export interface Theme {
  fg(color: string, text: string): string;
  bold(text: string): string;
}

type TuiLike = Pick<TUI, "requestRender"> & { terminal: { rows: number } };

export class LogViewer implements Component {
  private lines: string[] = [];
  private scroll = 0;
  private follow = true;
  private stopArmed = false;
  private closed = false;
  private readonly timer: ReturnType<typeof setInterval>;

  constructor(
    private readonly tui: TuiLike,
    private readonly theme: Theme,
    private readonly task: Task,
    private readonly stop: (() => void) | undefined,
    private readonly done: () => void,
  ) {
    this.reload();
    this.timer = setInterval(() => {
      if (this.closed) return;
      this.reload();
      this.tui.requestRender();
    }, 1_000);
    this.timer.unref?.();
  }

  private reload(): void {
    try {
      this.lines = tail(this.task.logPath, MAX_LINES);
    } catch {
      this.lines = ["(the log could not be read)"];
    }
  }

  private viewport(): number {
    return Math.max(3, Math.floor((this.tui.terminal.rows * HEIGHT_PCT) / 100) - CHROME);
  }

  handleInput(data: string): void {
    if (matchesKey(data, "escape") || matchesKey(data, "ctrl+c") || matchesKey(data, "q")) {
      this.close();
      return;
    }
    if (matchesKey(data, "x")) {
      if (this.task.status === "running" && this.stop) {
        if (this.stopArmed) {
          this.stopArmed = false;
          this.stop();
        } else this.stopArmed = true;
        this.tui.requestRender();
      }
      return;
    }
    this.stopArmed = false;
    const page = this.viewport();
    const max = Math.max(0, this.lines.length - page);
    if (matchesKey(data, "up") || matchesKey(data, "k")) this.scroll = Math.max(0, Math.min(this.scroll, max) - 1);
    else if (matchesKey(data, "down") || matchesKey(data, "j")) this.scroll = Math.min(max, this.scroll + 1);
    else if (matchesKey(data, "pageUp") || matchesKey(data, "ctrl+u")) this.scroll = Math.max(0, Math.min(this.scroll, max) - page);
    else if (matchesKey(data, "pageDown") || matchesKey(data, "ctrl+d")) this.scroll = Math.min(max, this.scroll + page);
    else if (matchesKey(data, "home") || matchesKey(data, "g")) this.scroll = 0;
    else if (matchesKey(data, "end") || matchesKey(data, "shift+g")) this.scroll = max;
    else return;
    this.follow = this.scroll >= max;
    this.tui.requestRender();
  }

  private close(): void {
    if (this.closed) return;
    this.closed = true;
    this.done();
  }

  render(width: number): string[] {
    if (width < 10) return [];
    const th = this.theme;
    const inner = width - 4;
    const row = (s: string) => `${th.fg("border", "│")} ${truncateToWidth(s, inner, "…", true)} ${th.fg("border", "│")}`;
    const rule = row(th.fg("dim", "─".repeat(inner)));
    const t = this.task;
    const out = [th.fg("border", `╭${"─".repeat(width - 2)}╮`)];
    const mark = t.status === "running" ? th.fg("accent", "●") : t.status === "done" ? th.fg("success", "✓") : th.fg("error", "✗");
    out.push(row(`${mark} ${th.bold(header(t))}`));
    out.push(row(th.fg("dim", `$ ${t.command.replace(/\s+/gu, " ")}`)));
    out.push(rule);
    const page = this.viewport();
    const max = Math.max(0, this.lines.length - page);
    if (this.follow) this.scroll = max;
    const start = Math.min(this.scroll, max);
    for (let i = 0; i < page; i++) out.push(row(this.lines[start + i] ?? (i === 0 && !this.lines.length ? th.fg("dim", "(no output yet)") : "")));
    out.push(rule);
    const actions: string[] = [];
    if (t.status === "running" && this.stop) actions.push(this.stopArmed ? th.fg("error", "x again to stop") : th.fg("dim", "x stop"));
    const position = this.lines.length <= page ? "all" : `${Math.round(((start + page) / this.lines.length) * 100)}%`;
    actions.push(th.fg("dim", `${this.lines.length} lines · ${position}${this.follow && t.status === "running" ? " · following" : ""}`));
    const left = actions.join(th.fg("dim", " · "));
    const nav = th.fg("dim", "↑↓ PgUp/PgDn g/G · Esc close");
    const gap = inner - visibleWidth(left) - visibleWidth(nav);
    out.push(row(gap >= 1 ? `${left}${" ".repeat(gap)}${nav}` : left));
    out.push(th.fg("border", `╰${"─".repeat(width - 2)}╯`));
    return out;
  }

  invalidate(): void {}

  dispose(): void {
    this.closed = true;
    clearInterval(this.timer);
  }
}
