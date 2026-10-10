// The activity protocol: how pi-subagents and pi-bg share one panel above the editor and one
// keyboard list below it when both are installed. Each works alone; with both, pi-subagents is the
// host and pi-bg a section of its panel. This file is copied verbatim into both repos (pi-bg and
// pi-subagents); change it in both.
//
// Over pi's event bus:
//   activity:section  { section }  a provider offers a section, at its session start and whenever a
//                                  host announces itself
//   activity:host     {}           a host is ready (at its session start): providers offer again
//   activity:changed  { id }       a provider's content changed: the host redraws
//   activity:gone     { id }       a provider is going away (session end, reload)
// The host calls section.setHosted(true) when it shows the section, and setHosted(false) when it
// stops (its own session end). While hosted, a provider shows no panel of its own.

export const ACTIVITY_SECTION = "activity:section";
export const ACTIVITY_HOST = "activity:host";
export const ACTIVITY_CHANGED = "activity:changed";
export const ACTIVITY_GONE = "activity:gone";

export interface ActivityTheme {
  fg(color: string, text: string): string;
  bold(text: string): string;
}

export interface SectionFrame {
  width: number;
  theme: ActivityTheme;
  now: number;
  /** Spinner frame, advanced by the host every 100 ms. */
  frame: number;
  /** The most lines the section may use, its header row included (at least 2). */
  maxLines: number;
}

export interface SectionRender {
  lines: string[];
  /** For each line, the key of the entry a double-click on it opens (or undefined). */
  targets: (string | undefined)[];
}

/** One row of the keyboard list below the editor. */
export interface ActivityEntry {
  key: string;
  /** Bold when selected: `tests`, `vite`. */
  label: string;
  /** Beside the label: the command, the task. */
  detail: string;
  status: "running" | "done" | "failed" | "stopped";
  /** Flush right: `2:14 · job`. */
  stats: string;
  startedAt: number;
}

export interface ActivitySection {
  id: string;
  /** What its entries are, for the list's hint: `background tasks`. */
  title: string;
  /** Whether the section has anything to show in the panel now. */
  hasContent(now: number): boolean;
  /** The section in the panel: its header row, then its rows, within `maxLines`. */
  render(frame: SectionFrame): SectionRender;
  /** Entries for the keyboard list: running, or ended in the last few seconds. */
  entries(now: number): ActivityEntry[];
  /** Opens an entry's detail view (an overlay through `ui.custom`); resolves when it closes. */
  open(key: string, ui: unknown): Promise<void>;
  /** Stops a running entry. */
  stop?(key: string): void;
  setHosted(hosted: boolean): void;
}

export interface EventBus {
  emit(channel: string, data: unknown): void;
  on(channel: string, handler: (data: unknown) => void): unknown;
}
