// A stand-in for pi's ExtensionAPI and context, enough to load the extension and call its tools.
export function fakePi() {
  const handlers = new Map<string, ((event: any, ctx: any) => any)[]>();
  const bus = new Map<string, ((data: any) => void)[]>();
  const tools = new Map<string, any>();
  const commands = new Map<string, any>();
  const sent: { message: any; options: any }[] = [];
  const emitted: { channel: string; data: any }[] = [];
  const pi = {
    on(event: string, fn: any) {
      handlers.set(event, [...(handlers.get(event) ?? []), fn]);
      return () => {};
    },
    events: {
      on(channel: string, fn: any) {
        bus.set(channel, [...(bus.get(channel) ?? []), fn]);
        return () => {};
      },
      emit(channel: string, data: any) {
        emitted.push({ channel, data });
        for (const fn of bus.get(channel) ?? []) fn(data);
      },
    },
    registerTool(def: any) {
      tools.set(def.name, def);
    },
    registerCommand(name: string, def: any) {
      commands.set(name, def);
    },
    sendMessage(message: any, options: any) {
      sent.push({ message, options });
    },
  };
  return { pi, handlers, tools, commands, sent, emitted, bus };
}

export function fakeCtx(cwd: string) {
  const status = new Map<string, string | undefined>();
  const notes: string[] = [];
  const working: (string | undefined)[] = [];
  const state = { pending: false, editorText: "", busy: false };
  const inputs = new Set<(data: string) => { consume?: boolean } | undefined>();
  const widgets = new Map<string, any>();
  const opened: any[] = [];
  const ctx = {
    mode: "tui",
    hasUI: true,
    cwd,
    sessionManager: { getSessionId: () => "test-session" },
    hasPendingMessages: () => state.pending,
    isIdle: () => !state.busy,
    ui: {
      setStatus: (k: string, v: string | undefined) => status.set(k, v),
      setWidget: (k: string, v: any) => (v ? widgets.set(k, v) : widgets.delete(k)),
      notify: (m: string) => notes.push(m),
      setWorkingMessage: (m?: string) => working.push(m),
      select: async () => undefined,
      pasteToEditor: () => {},
      custom: (factory: any) =>
        new Promise((resolve) => {
          opened.push({ factory, resolve });
        }),
      onTerminalInput: (h: any) => {
        inputs.add(h);
        return () => inputs.delete(h);
      },
      getEditorText: () => state.editorText,
    },
  };
  const theme = { fg: (_c: string, t: string) => t, bold: (t: string) => t, inverse: (t: string) => `[${t}]` };
  const tui = { requestRender: () => {}, terminal: { rows: 40 } };
  /** The widget's current lines, rendered at `width` with a plain theme. */
  const widgetLines = (key = "pi-bg-pill", width = 200): string[] | undefined => widgets.get(key)?.(tui, theme).render(width);
  /** The widget component itself, to send it mouse events. */
  const widgetComponent = (key = "pi-bg-pill") => widgets.get(key)?.(tui, theme);
  /** Feed a key through the input listeners; true when one consumed it. */
  const press = (data: string) => [...inputs].some((h) => h(data)?.consume);
  /** The overlay opened `index`-th through ui.custom, built with the plain theme. */
  const overlay = (index = 0) => {
    const o = opened[index];
    return o ? o.factory(tui, theme, undefined, o.resolve) : undefined;
  };
  return { ctx, status, notes, working, state, widgets, widgetLines, widgetComponent, opened, press, overlay, theme };
}

export async function until(cond: () => boolean, ms = 5_000): Promise<void> {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error("timed out waiting for a condition");
    await new Promise((r) => setTimeout(r, 20));
  }
}
