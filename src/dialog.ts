// The background-tasks dialog (`/tasks`, or Enter on the pill): Claude Code's Background dialog.
// Every source's entries, grouped: pi-bg's shells and, with pi-subagents installed, its subagent
// runs. ↑↓ (or j/k) select; Enter opens the entry (a shell's live log, a run's conversation) and
// comes back here when it closes; `x` stops a running entry (press twice) or dismisses an ended
// one; `r` reruns a shell; `f` follows a shell's log in a herdr split; Esc, q or ← closes.
import { type Component, type TUI, matchesKey, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import type { ActivityEntry, ActivitySection } from "./activity.ts";

const HEIGHT_PCT = 80;
/** Border, title, rule, rule, hints, border. */
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

type Row = { kind: "heading"; text: string } | { kind: "entry"; section: ActivitySection; entry: ActivityEntry } | { kind: "blank" };

type TuiLike = Pick<TUI, "requestRender"> & { terminal: { rows: number } };

const icon = (status: ActivityEntry["status"], theme: Theme) =>
  status === "running" ? theme.fg("accent", "●") : status === "done" ? theme.fg("success", "✓") : status === "stopped" ? theme.fg("muted", "■") : theme.fg("error", "✗");

/** The dialog's rows: each source with entries under a heading, running entries first. */
export function dialogRows(sections: ActivitySection[], now: number): Row[] {
  const rows: Row[] = [];
  for (const section of sections) {
    const entries = section.entries(now);
    if (!entries.length) continue;
    const running = entries.filter((e) => e.status === "running").length;
    if (rows.length) rows.push({ kind: "blank" });
    const title = section.title.charAt(0).toUpperCase() + section.title.slice(1);
    rows.push({ kind: "heading", text: `${title}${running ? ` · ${running} running` : ""}` });
    for (const entry of entries) rows.push({ kind: "entry", section, entry });
  }
  return rows;
}

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

  private entryRows(): Extract<Row, { kind: "entry" }>[] {
    return this.rows.filter((r): r is Extract<Row, { kind: "entry" }> => r.kind === "entry");
  }

  private current(): Extract<Row, { kind: "entry" }> | undefined {
    return this.entryRows()[this.selected];
  }

  handleInput(data: string): void {
    if (matchesKey(data, "escape") || matchesKey(data, "ctrl+c") || matchesKey(data, "q") || matchesKey(data, "left")) return this.close(undefined);
    const cur = this.current();
    const armed = this.stopArmed;
    this.stopArmed = false;
    const count = this.entryRows().length;
    if (matchesKey(data, "up") || matchesKey(data, "k")) this.selected = Math.max(0, this.selected - 1);
    else if (matchesKey(data, "down") || matchesKey(data, "j")) this.selected = Math.min(Math.max(0, count - 1), this.selected + 1);
    else if ((matchesKey(data, "enter") || matchesKey(data, "right")) && cur) return this.close({ kind: "open", section: cur.section, key: cur.entry.key });
    else if (matchesKey(data, "x") && cur) {
      if (cur.entry.status === "running") {
        if (!cur.section.stop) return;
        // Two presses, so a stray x cannot kill a task.
        if (armed) cur.section.stop(cur.entry.key);
        else this.stopArmed = true;
      } else {
        cur.section.dismiss?.(cur.entry.key);
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
    return Math.max(3, Math.floor((this.tui.terminal.rows * HEIGHT_PCT) / 100) - CHROME);
  }

  render(width: number): string[] {
    if (width < 12) return [];
    const th = this.theme;
    const inner = width - 4;
    const row = (s: string) => `${th.fg("border", "│")} ${truncateToWidth(s, inner, "…", true)} ${th.fg("border", "│")}`;
    const rule = row(th.fg("dim", "─".repeat(inner)));
    const out = [th.fg("border", `╭${"─".repeat(width - 2)}╮`)];
    const entries = this.entryRows();
    const running = entries.filter((r) => r.entry.status === "running").length;
    out.push(row(`${th.bold("Background tasks")}${th.fg("dim", entries.length ? `  ${running} running · ${entries.length - running} ended` : "")}`));
    out.push(rule);

    const lines: string[] = [];
    let selectedLine = 0;
    let n = 0;
    for (const r of this.rows) {
      if (r.kind === "blank") lines.push("");
      else if (r.kind === "heading") lines.push(th.fg("muted", r.text));
      else {
        const on = n === this.selected;
        if (on) selectedLine = lines.length;
        const e = r.entry;
        const name = on ? th.bold(th.fg("text", e.label)) : e.label;
        const left = `${on ? th.fg("accent", "❯") : " "} ${icon(e.status, th)} ${name}  ${th.fg("dim", e.detail)}`;
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
    for (let i = 0; i < Math.min(page, lines.length); i++) out.push(row(lines[this.scroll + i] ?? ""));

    out.push(rule);
    const cur = this.current();
    const hints: string[] = [];
    if (cur) {
      hints.push("enter view");
      if (cur.entry.status === "running" && cur.section.stop) hints.push(this.stopArmed ? th.fg("error", `x again to stop ${cur.entry.label}`) : "x stop");
      else if (cur.entry.status !== "running" && cur.section.dismiss) hints.push("x dismiss");
      if (cur.section.id === this.options.ownId) {
        hints.push("r rerun");
        if (this.options.canFollow) hints.push("f follow in a split");
      }
    }
    hints.push("esc close");
    out.push(row(th.fg("dim", hints.join(" · "))));
    out.push(th.fg("border", `╰${"─".repeat(width - 2)}╯`));
    return out;
  }

  invalidate(): void {}

  dispose(): void {
    this.closed = true;
    clearInterval(this.timer);
  }
}
