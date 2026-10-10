// The full-screen frame of pi-bg's views (the background-tasks dialog, a task's log): they take over
// the whole screen, the way Claude Code and Codex switch the main view to a subagent's transcript,
// with a banner in the accent color that says this is not the main session and how to get back.
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";

export interface FrameTheme {
  fg(color: string, text: string): string;
  bold(text: string): string;
}

/** ui.custom options for a view that covers the screen. */
export const FULL_SCREEN = { overlay: true, overlayOptions: { anchor: "top-left" as const, width: "100%" as const, maxHeight: "100%" as const } };

/** Rows the frame takes: banner, a rule under the header, a rule above the hints, the hints, the bottom border. */
export const FRAME_ROWS = 5;

/** `╭─ ◀ esc · Background tasks · not your main session ──╮`, in the accent color. */
export function banner(title: string, width: number, theme: FrameTheme): string {
  const label = ` ◀ esc · ${title} · not your main session `;
  const fill = Math.max(0, width - 3 - visibleWidth(label));
  return theme.fg("accent", `╭─${theme.bold(truncateToWidth(label, Math.max(4, width - 3)))}${"─".repeat(fill)}╮`);
}

export function bottom(width: number, theme: FrameTheme): string {
  return theme.fg("accent", `╰${"─".repeat(Math.max(0, width - 2))}╯`);
}

/** One content row inside the frame. */
export function row(content: string, width: number, theme: FrameTheme): string {
  const inner = Math.max(1, width - 4);
  return `${theme.fg("accent", "│")} ${truncateToWidth(content, inner, "…", true)} ${theme.fg("accent", "│")}`;
}

export function rule(width: number, theme: FrameTheme): string {
  return row(theme.fg("dim", "─".repeat(Math.max(1, width - 4))), width, theme);
}
