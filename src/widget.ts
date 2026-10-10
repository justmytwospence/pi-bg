// The live background-task widget above the editor, in the style of pi-subagents' widget: one row
// per running task (spinner, name, kind, time, tags, command) with its latest log line beneath,
// then tasks that ended for a few seconds with their outcome. It registers once and refreshes with
// requestRender(), and hides itself when nothing is left to show. Double-clicking a task's row
// (fullscreen mode, where pi passes mouse events to widgets) opens its log. With pi-subagents
// installed, the same rows are a section of its panel instead (activity.ts).
import type { TUI, TuiMouseEvent, TuiMouseEventResult } from "@earendil-works/pi-tui";
import { truncateToWidth } from "@earendil-works/pi-tui";
import { outcome, runtime } from "./format.ts";
import { tail } from "./log.ts";
import type { Task } from "./registry.ts";

const WIDGET_KEY = "pi-bg";
/** Content rows before the rest collapse into `+N more`. */
export const MAX_LINES = 12;
const FRAME_MS = 100;
/** How often a running task's latest log line is read again. */
const LAST_LINE_MS = 1_000;
const SPINNER = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
/** How long a task that succeeded stays. A failure, timeout or stop stays until the user's next message. */
export const LINGER_MS = { done: 8_000 };

export interface Theme {
  fg(color: string, text: string): string;
  bold(text: string): string;
}

/** Whether an ended task still shows: a success for 8 s; anything else until a message after it ended (`dismissedAt`). */
export function lingers(t: Task, now: number, dismissedAt: number): boolean {
  if (t.status === "running" || t.endedAt === undefined) return false;
  return t.status === "done" ? now - t.endedAt < LINGER_MS.done : t.endedAt > dismissedAt;
}

export function widgetTasks(tasks: readonly Task[], now: number, dismissedAt: number): Task[] {
  return tasks.filter((t) => t.status === "running" || lingers(t, now, dismissedAt));
}

export interface WidgetFrame {
  /** Rows at most, header included (default 12). */
  maxLines?: number;
  tasks: readonly Task[];
  /** Tasks a bg_wait is waiting on. */
  waiting: ReadonlySet<string>;
  lastLine: (t: Task) => string | undefined;
  now: number;
  frame: number;
  width: number;
  theme: Theme;
}

const oneLine = (s: string) => s.replace(/\s+/gu, " ").trim();

/** The widget's lines, or [] when there is nothing to show. */
export function renderWidget(f: WidgetFrame): string[] {
  const { lines } = renderSection(f);
  return lines.length ? withSpacer(lines) : lines;
}

/** The rows without the trailing spacer, and which task each line belongs to. */
export function renderSection({ tasks, waiting, lastLine, now, frame, width, theme, maxLines = MAX_LINES }: WidgetFrame): { lines: string[]; targets: (string | undefined)[] } {
  const running = tasks.filter((t) => t.status === "running");
  // Successes one row each; failures and stops share one row, the latest, with a count of the rest.
  const done = tasks.filter((t) => t.status === "done");
  const held = tasks.filter((t) => t.status !== "running" && t.status !== "done").sort((a, b) => (a.endedAt ?? 0) - (b.endedAt ?? 0));
  const latest = held.at(-1);
  const ended = latest ? [...done, latest] : done;
  const moreEnded = held.length - 1;
  if (!running.length && !ended.length) return { lines: [], targets: [] };
  const max = Math.max(2, maxLines);
  const cut = (line: string) => truncateToWidth(line, width);
  const spinner = SPINNER[frame % SPINNER.length] ?? "●";
  const dot = theme.fg("dim", " · ");

  const tags = (t: Task) => {
    const out: string[] = [];
    if (waiting.has(t.id)) out.push(theme.fg("accent", "waiting"));
    if (t.origin === "user") out.push(theme.fg("muted", "yours"));
    if (t.keep) out.push(theme.fg("muted", "kept"));
    return out.length ? `${dot}${out.join(dot)}` : "";
  };

  const runningRows = running.map((t) => {
    const icon = t.kind === "service" && t.ready ? theme.fg("success", "●") : theme.fg("accent", spinner);
    const state = t.kind === "service" ? `${t.ready ? "ready" : t.readyPattern ? "starting" : "up"} ${runtime(t, now)}` : runtime(t, now);
    const head = `${theme.fg("dim", "├─")} ${icon} ${theme.bold(t.name)}  ${theme.fg("muted", `${t.kind} · ${state}`)}${tags(t)}${dot}${theme.fg("dim", oneLine(t.command))}`;
    const last = lastLine(t);
    return [cut(head), cut(theme.fg("dim", `│    ⎿  ${last ? oneLine(last) : "(no output yet)"}`))];
  });
  const endedRows = ended.map((t) => {
    const icon = t.status === "done" ? theme.fg("success", "✓") : t.status === "killed" ? theme.fg("muted", "■") : theme.fg("error", "✗");
    const what = `${outcome(t)} after ${runtime(t, now)}`;
    const bad = t.status === "failed" || t.status === "timeout";
    const last = bad ? lastLine(t) : undefined;
    const more = t === latest && moreEnded > 0 ? theme.fg("dim", ` · +${moreEnded} more ended`) : "";
    return cut(`${theme.fg("dim", "├─")} ${icon} ${theme.fg("muted", t.name)}  ${bad ? theme.fg("error", what) : theme.fg("dim", what)}${more}${last ? theme.fg("dim", ` · ${oneLine(last)}`) : ""}`);
  });

  const jobs = running.filter((t) => t.kind === "job").length;
  const services = running.length - jobs;
  const counts = [jobs ? `${jobs} running` : "", services ? `${services} service${services === 1 ? "" : "s"}` : ""].filter(Boolean).join(", ");
  const active = running.length > 0;
  const color = active ? "accent" : "dim";
  const lines = [cut(`${theme.fg(color, active ? "●" : "○")} ${theme.fg(color, "Background")}${counts ? theme.fg("dim", `  ${counts}`) : ""}`)];
  const targets: (string | undefined)[] = [undefined];

  const body = runningRows.length * 2 + endedRows.length;
  if (body <= max - 1) {
    running.forEach((t, i) => {
      lines.push(...(runningRows[i] as string[]));
      targets.push(t.id, t.id);
    });
    ended.forEach((t, i) => {
      lines.push(endedRows[i] as string);
      targets.push(t.id);
    });
    closeTree(lines, !endedRows.length && runningRows.length > 0);
    return { lines, targets };
  }
  // Too many: running first, then ended; the rest becomes `+N more`.
  let budget = max - 2;
  let hiddenRunning = 0;
  let hiddenEnded = 0;
  running.forEach((t, i) => {
    if (budget >= 2) {
      lines.push(...(runningRows[i] as string[]));
      targets.push(t.id, t.id);
      budget -= 2;
    } else hiddenRunning++;
  });
  ended.forEach((t, i) => {
    if (budget >= 1) {
      lines.push(endedRows[i] as string);
      targets.push(t.id);
      budget--;
    } else hiddenEnded++;
  });
  const hidden = [hiddenRunning ? `${hiddenRunning} running` : "", hiddenEnded ? `${hiddenEnded} ended` : ""].filter(Boolean).join(", ");
  lines.push(cut(`${theme.fg("dim", "└─")} ${theme.fg("dim", `+${hiddenRunning + hiddenEnded} more (${hidden}) · /bg`)}`));
  targets.push(undefined);
  return { lines, targets };
}

/** A blank row below, so the tree does not touch the editor's border. */
function withSpacer(lines: string[]): string[] {
  lines.push("");
  return lines;
}

/** Turn the last item's `├─` into `└─` (and its log line's `│` into a space). */
function closeTree(lines: string[], lastIsRunning: boolean) {
  const last = lines.length - 1;
  if (last < 1) return;
  if (lastIsRunning && last >= 2) {
    lines[last - 1] = (lines[last - 1] ?? "").replace("├─", "└─");
    lines[last] = (lines[last] ?? "").replace("│  ", "   ");
  } else lines[last] = (lines[last] ?? "").replace("├─", "└─");
}

/** The part of `ctx.ui` the widget uses. */
export interface WidgetUI {
  setWidget(
    key: string,
    content: ((tui: TUI, theme: any) => { render(width: number): string[]; invalidate(): void; handleMouse?(e: TuiMouseEvent): TuiMouseEventResult | undefined }) | undefined,
    options?: { placement?: "aboveEditor" | "belowEditor" },
  ): void;
  readonly theme?: Theme;
}

export interface WidgetSource {
  tasks(): readonly Task[];
  waiting(): ReadonlySet<string>;
  /** When the user last sent a message: failures and stops that ended before it are hidden. */
  dismissedAt(): number;
  /** A row was double-clicked: open that task's log. */
  open?(id: string): void;
}

/** A double-click of the left button (pi passes mouse events only in fullscreen mode). */
export function isDoubleClick(e: TuiMouseEvent): boolean {
  return e.type === "click" && e.button === "left" && (e.clickCount ?? 1) >= 2;
}

export class TasksWidget {
  private ui: WidgetUI | undefined;
  private tui: TUI | undefined;
  private registered = false;
  private timer: ReturnType<typeof setInterval> | undefined;
  private frame = 0;
  private readonly lines = new Map<string, { line: string | undefined; at: number }>();

  constructor(private readonly source: WidgetSource) {}

  /** Bind to a session's UI; a new UI (after /reload) re-registers on the next update. */
  setUI(ui: WidgetUI | undefined): void {
    if (ui === this.ui) return;
    this.hide();
    this.ui = ui;
  }

  /** A task's latest non-empty log line, read at most once a second (once more after it ended). */
  lastLine(t: Task, now = Date.now()): string | undefined {
    const cached = this.lines.get(t.id);
    const fresh = cached && (t.status === "running" ? now - cached.at < LAST_LINE_MS : cached.at >= (t.endedAt ?? 0));
    if (fresh) return cached.line;
    let line: string | undefined;
    try {
      line = tail(t.logPath, 5).filter((l) => l.trim()).pop();
    } catch {
      line = undefined;
    }
    this.lines.set(t.id, { line, at: now });
    return line;
  }

  private visible(now: number): Task[] {
    return widgetTasks(this.source.tasks(), now, this.source.dismissedAt());
  }

  /** Whether there is anything to show now. */
  hasContent(now = Date.now()): boolean {
    return this.visible(now).length > 0;
  }

  /** The rows (no spacer), for this widget or a host's panel. */
  section(f: { width: number; theme: Theme; now: number; frame: number; maxLines: number }): { lines: string[]; targets: (string | undefined)[] } {
    return renderSection({ tasks: this.visible(f.now), waiting: this.source.waiting(), lastLine: (t) => this.lastLine(t, f.now), ...f });
  }

  update(): void {
    if (!this.ui) return;
    if (!this.visible(Date.now()).length) {
      this.hide();
      return;
    }
    if (!this.timer) {
      this.timer = setInterval(() => {
        this.frame++;
        this.update();
      }, FRAME_MS);
      this.timer.unref?.();
    }
    if (this.registered) {
      this.tui?.requestRender();
      return;
    }
    const ui = this.ui;
    let targets: (string | undefined)[] = [];
    ui.setWidget(
      WIDGET_KEY,
      (tui, factoryTheme: Theme) => {
        this.tui = tui;
        return {
          render: (width: number) => {
            const r = this.section({ width, theme: ui.theme ?? factoryTheme, now: Date.now(), frame: this.frame, maxLines: MAX_LINES });
            targets = r.targets;
            return r.lines.length ? withSpacer(r.lines) : r.lines;
          },
          handleMouse: (e: TuiMouseEvent): TuiMouseEventResult | undefined => {
            const id = targets[e.y];
            if (!id || !this.source.open) return undefined;
            // pi turns a press and release into a click only for the component that took the press.
            if (e.type === "press" && e.button === "left") return { handled: true, render: false };
            if (!isDoubleClick(e)) return undefined;
            this.source.open(id);
            return { handled: true };
          },
          invalidate: () => undefined,
        };
      },
      { placement: "aboveEditor" },
    );
    this.registered = true;
  }

  private hide(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    if (this.registered) this.ui?.setWidget(WIDGET_KEY, undefined);
    this.registered = false;
    this.tui = undefined;
  }

  dispose(): void {
    this.hide();
    this.ui = undefined;
    this.lines.clear();
  }
}
