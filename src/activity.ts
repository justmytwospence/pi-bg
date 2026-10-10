// The activity protocol: how pi-bg and pi-subagents share the space under the prompt and one
// background-tasks dialog when both are installed, the way Claude Code lays them out. Each works
// alone. This file is copied verbatim into both repos (pi-bg and pi-subagents); change it in both.
//
// Each extension offers its background work as a *source*. With both installed:
// - pi-subagents is the host under the prompt: its list (FleetView, Claude Code's subagent panel)
//   ends with pi-bg's pill (`2 shells`), and calls `setHosted(true)` so pi-bg draws no pill of its
//   own. Enter on the pill opens pi-bg's dialog.
// - pi-bg's `/tasks` dialog lists every source's entries: its shells, and pi-subagents' runs.
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
  /** A host shows this source under the prompt (true) or stopped doing so (false). */
  setHosted?(hosted: boolean): void;
}

export interface EventBus {
  emit(channel: string, data: unknown): void;
  on(channel: string, handler: (data: unknown) => void): unknown;
}
