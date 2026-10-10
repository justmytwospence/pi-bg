// The pill under the prompt, Claude Code's background-tasks indicator: `2 shells`, plus
// `1 failed` in the error color while a failure is unseen. `↓` at the bottom of the prompt (or `j`
// in pi-vim's normal mode) selects it, even with a draft in the prompt; Enter, `l` or a click opens
// the background-tasks view; Esc, `↑`, `k` or `h` goes back to the prompt.
// With pi-subagents installed it draws nothing: pi-subagents' list under the prompt ends with the
// same pill (activity.ts).
import { type TUI, type TuiMouseEvent, type TuiMouseEventResult, isKeyRelease, matchesKey, truncateToWidth } from "@earendil-works/pi-tui";
import { type ActivityPill, leavesPromptDown } from "./activity.ts";

const KEY = "pi-bg-pill";

export interface Theme {
  fg(color: string, text: string): string;
  bold(text: string): string;
  inverse?(text: string): string;
}

/** The pill's line(s): the label (inverse when selected), and a key hint while selected. */
export function renderPill(pill: ActivityPill | undefined, selected: boolean, width: number, theme: Theme): string[] {
  if (!pill) return [];
  const inverse = (s: string) => (theme.inverse ? theme.inverse(s) : `\x1b[7m${s}\x1b[27m`);
  const label = selected ? inverse(` ${pill.label} `) : theme.fg("muted", ` ${pill.label} `);
  const alert = pill.alert ? `${theme.fg("dim", "·")} ${theme.fg("error", pill.alert)}` : "";
  const hint = selected ? theme.fg("dim", "  l/enter view · h/esc back") : "";
  return [truncateToWidth(` ${label}${alert ? ` ${alert}` : ""}${hint}`, width)];
}

export interface PillUI {
  setWidget(
    key: string,
    content: ((tui: TUI, theme: any) => { render(width: number): string[]; invalidate(): void; handleMouse?(e: TuiMouseEvent): TuiMouseEventResult | undefined }) | undefined,
    options?: { placement?: "aboveEditor" | "belowEditor" },
  ): void;
  onTerminalInput(handler: (data: string) => { consume?: boolean; data?: string } | undefined): () => void;
  getEditorText(): string;
  readonly theme?: Theme;
}

export interface PillSource {
  pill(now: number): ActivityPill | undefined;
  /** Enter or a click: open the dialog. */
  open(): void;
}

type KeyResult = { consume?: boolean; data?: string } | undefined;

export class PillView {
  private ui: PillUI | undefined;
  private tui: TUI | undefined;
  private registered = false;
  private selected = false;
  private unsubscribe: (() => void) | undefined;

  constructor(private readonly source: PillSource) {}

  /** Bind to a session's UI, or to none (outside the TUI, or while another extension hosts the pill). */
  setUI(ui: PillUI | undefined): void {
    if (ui === this.ui) return;
    this.hide();
    this.unsubscribe?.();
    this.unsubscribe = undefined;
    this.ui = ui;
    if (ui) this.unsubscribe = ui.onTerminalInput((data) => this.handleKey(data));
  }

  update(): void {
    const ui = this.ui;
    if (!ui) return;
    if (!this.source.pill(Date.now())) {
      this.hide();
      return;
    }
    if (this.registered) {
      this.tui?.requestRender();
      return;
    }
    ui.setWidget(
      KEY,
      (tui, factoryTheme: Theme) => {
        this.tui = tui;
        return {
          render: (width: number) => renderPill(this.source.pill(Date.now()), this.selected, width, ui.theme ?? factoryTheme),
          handleMouse: (e: TuiMouseEvent): TuiMouseEventResult | undefined => {
            if (e.button !== "left") return undefined;
            // pi turns a press and release into a click only for the component that took the press.
            if (e.type === "press") return { handled: true, render: false };
            if (e.type !== "click") return undefined;
            this.selected = false;
            this.source.open();
            return { handled: true };
          },
          invalidate: () => undefined,
        };
      },
      { placement: "belowEditor" },
    );
    this.registered = true;
  }

  /** `{ consume: true }` for the keys the pill takes; undefined lets a key through. */
  handleKey(data: string): KeyResult {
    if (!this.ui || !this.registered || isKeyRelease(data)) return undefined;
    if (!this.editorFocused()) {
      this.deselect();
      return undefined;
    }
    if (!this.selected) {
      const focused = this.focused();
      // Without a view of the editor, only an empty prompt is safe to leave.
      const down = focused ? leavesPromptDown(focused, data, matchesKey(data, "down"), data === "j") : matchesKey(data, "down") && this.ui.getEditorText() === "";
      if (down) {
        this.selected = true;
        this.tui?.requestRender();
        return { consume: true };
      }
      return undefined;
    }
    if (matchesKey(data, "enter") || matchesKey(data, "l") || matchesKey(data, "right")) {
      this.deselect();
      this.source.open();
      return { consume: true };
    }
    if (matchesKey(data, "escape") || matchesKey(data, "up") || matchesKey(data, "k") || matchesKey(data, "h") || matchesKey(data, "left")) {
      this.deselect();
      return { consume: true };
    }
    if (matchesKey(data, "down") || matchesKey(data, "j")) return { consume: true };
    // Anything else goes back to the editor.
    this.deselect();
    return undefined;
  }

  get isSelected(): boolean {
    return this.selected;
  }

  private deselect(): void {
    if (!this.selected) return;
    this.selected = false;
    this.tui?.requestRender();
  }

  private focused(): unknown {
    const tui = this.tui as unknown as { getFocusedComponent?: () => unknown; focusedComponent?: unknown } | undefined;
    return typeof tui?.getFocusedComponent === "function" ? tui.getFocusedComponent() : tui?.focusedComponent;
  }

  /** Pi's editor has `getText` and `setText`; its dialogs and overlays do not. Unknown focus counts as the editor. */
  private editorFocused(): boolean {
    const focused = this.focused();
    if (focused == null) return true;
    const c = focused as { getText?: unknown; setText?: unknown };
    return typeof c.getText === "function" && typeof c.setText === "function";
  }

  private hide(): void {
    this.selected = false;
    if (this.registered) this.ui?.setWidget(KEY, undefined);
    this.registered = false;
    this.tui = undefined;
  }

  dispose(): void {
    this.hide();
    this.unsubscribe?.();
    this.unsubscribe = undefined;
    this.ui = undefined;
  }
}
