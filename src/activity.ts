// The activity protocol: how pi-bg, pi-subagents and pi-marimo share the space under the prompt and
// one background-tasks dialog, the way Claude Code lays them out. Each works alone. This file is
// copied verbatim into pi-bg, pi-subagents and pi-marimo; change it in all three.
//
// Each extension offers its background work as a *source*:
// - pi-subagents is the host under the prompt: its list (FleetView, Claude Code's subagent panel)
//   ends with the other sources' pills (`2 shells`, `1 notebook`), and calls `setHosted(true)` on
//   each so they draw no pill of their own. Enter on a pill opens that source's dialog.
// - Without pi-subagents, pi-bg hosts: its pill also counts the other sources' work
//   (`2 shells · 1 notebook`), calling `setHosted(true, "pi-bg")` on them.
// - pi-bg's `/tasks` dialog lists every source's entries: its shells, pi-subagents' runs,
//   pi-marimo's notebooks.
//
// Over pi's event bus:
//   activity:section  { section }  a source is offered, at its owner's session start and whenever
//                                  a host announces itself
//   activity:host     {}           a host is ready (at its session start): sources are offered again
//   activity:changed  { id }       a source's content changed: whoever shows it redraws
//   activity:gone     { id }       a source is going away (session end, reload)

export const ACTIVITY_SECTION = "activity:section";
export const ACTIVITY_HOST = "activity:host";
export const ACTIVITY_CHANGED = "activity:changed";
export const ACTIVITY_GONE = "activity:gone";

export interface ActivityTheme {
  fg(color: string, text: string): string;
  bold(text: string): string;
}

/** One piece of background work, for lists and dialogs. */
export interface ActivityEntry {
  key: string;
  /** `tests`, `scout`. */
  label: string;
  /** Beside the label: the command, the task. */
  detail: string;
  status: "running" | "done" | "failed" | "stopped";
  /** Flush right: `2:14`, `exit 1 · 0:12`, `1m00s · ↓ 13k tokens`. */
  stats: string;
  startedAt: number;
  /** When it ended, so a list mixing sources orders ended entries newest first. */
  endedAt?: number;
}

/** The compact label a source shows under the prompt, Claude Code's footer pill: `2 shells, 1 service`. */
export interface ActivityPill {
  label: string;
  /** Something failed or was stopped and has not been seen: drawn in the error color. */
  alert?: string;
}

export interface ActivitySection {
  id: string;
  /** What its entries are: `shells`, `subagents`. */
  title: string;
  /** One of them, tagged on each row of a list that mixes sources: `shell`, `agent`. */
  noun?: string;
  /** Running entries, then ended ones still worth showing (the source decides how long). */
  entries(now: number): ActivityEntry[];
  /** Opens an entry's detail view (an overlay through `ui.custom`); resolves when it closes. */
  open(key: string, ui: unknown): Promise<void>;
  /** Stops a running entry. */
  stop?(key: string): void;
  /** Removes an ended entry from lists now. */
  dismiss?(key: string): void;
  /** The pill under the prompt, or undefined when there is nothing to show. */
  pill?(now: number): ActivityPill | undefined;
  /** Opens the source's own dialog (pi-bg's background-tasks dialog). */
  openDialog?(ui: unknown): Promise<void>;
  /**
   * A host shows this source under the prompt (true) or stopped doing so (false). `host` names it
   * (pi-subagents leaves it out): a source draws its own pill only while no host shows it.
   */
  setHosted?(hosted: boolean, host?: string): void;
}

/**
 * Whether a key that moves down should leave the prompt for the list under it, as in Claude Code:
 * the prompt is empty, or its cursor sits at the end of its last line and no history entry is being
 * browsed (otherwise the editor moves the cursor first). With pi-vim, `j` in normal mode counts too.
 * `editor` is the focused component (pi's editor, or pi-vim's).
 */
export function leavesPromptDown(editor: unknown, data: string, isDown: boolean, isJ: boolean): boolean {
  const e = editor as {
    getText?: () => string;
    getLines?: () => string[];
    getCursor?: () => { line: number; col: number };
    isShowingAutocomplete?: () => boolean;
    historyIndex?: number;
    getMode?: () => string;
  } | null;
  void data;
  if (!e || typeof e.getText !== "function") return isDown;
  if (isJ && e.getMode?.() !== "normal") return false;
  if (!isDown && !isJ) return false;
  if (e.isShowingAutocomplete?.()) return false;
  if (typeof e.historyIndex === "number" && e.historyIndex > -1) return false;
  const lines = e.getLines?.() ?? e.getText().split("\n");
  const cursor = e.getCursor?.();
  if (!cursor) return e.getText() === "";
  const last = lines.length - 1;
  // vim normal mode: the cursor sits on the last character, not past it.
  const end = (lines[last] ?? "").length - (isJ ? 1 : 0);
  return cursor.line === last && cursor.col >= Math.max(0, end);
}

export interface EventBus {
  emit(channel: string, data: unknown): void;
  on(channel: string, handler: (data: unknown) => void): unknown;
}
