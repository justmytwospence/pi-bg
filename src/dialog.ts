// The background-tasks view (`/tasks`, or Enter on the pill): Claude Code's Background dialog, full
// screen. One list mixing every source (pi-bg's shells and, with pi-subagents installed, its
// subagent runs), each row tagged with what it is: running first (oldest first), then what ended
// (newest first). ↑↓ or j/k select; Enter, → or l opens the entry (a shell's live log, a run's
// conversation) and comes back here when it closes; `x` stops a running entry (press twice) or
// dismisses an ended one; `r` reruns a shell; `f` follows a shell's log in a herdr split; Esc, q, ←
// or h goes back.
import { type Component, type TUI, matchesKey, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import type { ActivityEntry, ActivitySection } from "./activity.ts";
import { banner, bottom, row as frameRow, rule as frameRule } from "./frame.ts";

/** Banner, summary, rule, rule, hints, bottom border. */
const CHROME = 6;
const TICK_MS = 1_000;

export interface Theme {
  fg(color: string, text: string): string;
  bold(text: string): string;
}

export type DialogResult =
  | { kind: "open"; section: ActivitySection; key: string }
  | { kind: "rerun"; key: string }
  | { kind: "follow"; key: string }
  | undefined;

export interface DialogOptions {
  /** The sources to list, the dialog owner's first. */
  sections: () => ActivitySection[];
  /** The owner's source id: `r` and `f` apply to its entries only. */
  ownId: string;
  /** Whether `f` (follow in a herdr split) is offered. */
  canFollow: boolean;
  /** Select this entry first (the one just viewed). */
  initialKey?: string;
}

type Row = { kind: "entry"; section: ActivitySection; entry: ActivityEntry };

type TuiLike = Pick<TUI, "requestRender"> & { terminal: { rows: number } };

/** Runs another source's code from a key handler, where a throw would escape into pi's input loop. */
const guard = (fn: () => void) => {
  try {
    fn();
  } catch {
    // Ignored: the source's own problem.
  }
};

const icon = (status: ActivityEntry["status"], theme: Theme) =>
  status === "running" ? theme.fg("accent", "●") : status === "done" ? theme.fg("success", "✓") : status === "stopped" ? theme.fg("muted", "■") : theme.fg("error", "✗");

/** The dialog's rows: every source's entries in one list, running first (oldest first), then ended (newest first). */
export function dialogRows(sections: ActivitySection[], now: number): Row[] {
  const rows: Row[] = [];
  for (const section of sections) {
    try {
      for (const entry of section.entries(now)) rows.push({ kind: "entry", section, entry });
    } catch {
      // Another extension's bug must not break the dialog (it renders on a timer).
    }
  }
  const running = rows.filter((r) => r.entry.status === "running").sort((a, b) => a.entry.startedAt - b.entry.startedAt);
  const ended = rows
    .filter((r) => r.entry.status !== "running")
    .sort((a, b) => (b.entry.endedAt ?? b.entry.startedAt) - (a.entry.endedAt ?? a.entry.startedAt));
  return [...running, ...ended];
}

/** `shell`, `agent`: what a row is, from its source. */
const nounOf = (section: ActivitySection) => section.noun ?? section.title.replace(/s$/u, "");

export class TasksDialog implements Component {
  private rows: Row[] = [];
  private selected = 0;
  private scroll = 0;
  private stopArmed = false;
  private closed = false;
  private readonly timer: ReturnType<typeof setInterval>;

  constructor(
    private readonly tui: TuiLike,
    private readonly theme: Theme,
    private readonly options: DialogOptions,
    private readonly done: (r: DialogResult) => void,
  ) {
    this.refresh();
    if (options.initialKey) {
      const i = this.entryRows().findIndex((r) => r.entry.key === options.initialKey);
      if (i >= 0) this.selected = i;
    }
    this.timer = setInterval(() => {
      if (this.closed) return;
      this.refresh();
      this.tui.requestRender();
    }, TICK_MS);
    this.timer.unref?.();
  }

  private refresh(): void {
    const key = this.current()?.entry.key;
    this.rows = dialogRows(this.options.sections(), Date.now());
    const entries = this.entryRows();
    const kept = key ? entries.findIndex((r) => r.entry.key === key) : -1;
    this.selected = kept >= 0 ? kept : Math.min(this.selected, Math.max(0, entries.length - 1));
  }

  private entryRows(): Row[] {
    return this.rows;
  }

  private current(): Row | undefined {
    return this.entryRows()[this.selected];
  }

  handleInput(data: string): void {
    if (matchesKey(data, "escape") || matchesKey(data, "ctrl+c") || matchesKey(data, "q") || matchesKey(data, "left") || matchesKey(data, "h")) return this.close(undefined);
    const cur = this.current();
    const armed = this.stopArmed;
    this.stopArmed = false;
    const count = this.entryRows().length;
    if (matchesKey(data, "up") || matchesKey(data, "k")) this.selected = Math.max(0, this.selected - 1);
    else if (matchesKey(data, "down") || matchesKey(data, "j")) this.selected = Math.min(Math.max(0, count - 1), this.selected + 1);
    else if ((matchesKey(data, "enter") || matchesKey(data, "right") || matchesKey(data, "l")) && cur) return this.close({ kind: "open", section: cur.section, key: cur.entry.key });
    else if (matchesKey(data, "x") && cur) {
      if (cur.entry.status === "running") {
        if (!cur.section.stop) return;
        // Two presses, so a stray x cannot kill a task.
        if (armed) guard(() => cur.section.stop?.(cur.entry.key));
        else this.stopArmed = true;
      } else {
        guard(() => cur.section.dismiss?.(cur.entry.key));
        this.refresh();
      }
    } else if (matchesKey(data, "r") && cur && cur.section.id === this.options.ownId) return this.close({ kind: "rerun", key: cur.entry.key });
    else if (matchesKey(data, "f") && cur && cur.section.id === this.options.ownId && this.options.canFollow) return this.close({ kind: "follow", key: cur.entry.key });
    else return;
    this.tui.requestRender();
  }

  private close(r: DialogResult): void {
    if (this.closed) return;
    this.closed = true;
    this.done(r);
  }

  private viewport(): number {
    return Math.max(3, this.tui.terminal.rows - CHROME);
  }

  render(width: number): string[] {
    if (width < 12) return [];
    const th = this.theme;
    const inner = width - 4;
    const row = (s: string) => frameRow(s, width, th);
    const rule = frameRule(width, th);
    const out = [banner("Background tasks", width, th)];
    const entries = this.entryRows();
    const running = entries.filter((r) => r.entry.status === "running").length;
    // Tags only when the list mixes kinds of work.
    const mixed = new Set(entries.map((r) => r.section.id)).size > 1;
    const tagWidth = Math.max(0, ...entries.map((r) => nounOf(r.section).length));
    out.push(row(th.fg("dim", entries.length ? `${running} running · ${entries.length - running} ended` : "Nothing running")));
    out.push(rule);

    const lines: string[] = [];
    let selectedLine = 0;
    let n = 0;
    for (const r of this.rows) {
      {
        const on = n === this.selected;
        if (on) selectedLine = lines.length;
        const e = r.entry;
        const name = on ? th.bold(th.fg("text", e.label)) : e.label;
        const tag = mixed ? `${th.fg("muted", nounOf(r.section).padEnd(tagWidth))} ` : "";
        const left = `${on ? th.fg("accent", "❯") : " "} ${icon(e.status, th)} ${tag}${name}  ${th.fg("dim", e.detail)}`;
        const right = th.fg(on ? "text" : "dim", e.stats);
        const gap = inner - visibleWidth(right) - 1;
        lines.push(visibleWidth(left) < gap ? `${left}${" ".repeat(gap - visibleWidth(left))} ${right}` : `${truncateToWidth(left, Math.max(8, gap - 1), "…")} ${right}`);
        n++;
      }
    }
    if (!lines.length) lines.push(th.fg("dim", "No tasks currently running"));
    const page = this.viewport();
    if (selectedLine < this.scroll) this.scroll = selectedLine;
    if (selectedLine >= this.scroll + page) this.scroll = selectedLine - page + 1;
    this.scroll = Math.max(0, Math.min(this.scroll, Math.max(0, lines.length - page)));
    // Every row, blank ones too: the view covers the whole screen.
    for (let i = 0; i < page; i++) out.push(row(lines[this.scroll + i] ?? ""));

    out.push(rule);
    const cur = this.current();
    const hints: string[] = [];
    if (cur) {
      hints.push("j/k move · l/enter view");
      if (cur.entry.status === "running" && cur.section.stop) hints.push(this.stopArmed ? th.fg("error", `x again to stop ${cur.entry.label}`) : "x stop");
      else if (cur.entry.status !== "running" && cur.section.dismiss) hints.push("x dismiss");
      if (cur.section.id === this.options.ownId) {
        hints.push("r rerun");
        if (this.options.canFollow) hints.push("f follow in a split");
      }
    }
    hints.push("h/esc back to your session");
    out.push(row(th.fg("dim", hints.join(" · "))));
    out.push(bottom(width, th));
    return out;
  }

  invalidate(): void {}

  dispose(): void {
    this.closed = true;
    clearInterval(this.timer);
  }
}
