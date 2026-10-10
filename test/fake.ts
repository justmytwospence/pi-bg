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
  const state = { pending: false };
  const widgets = new Map<string, any>();
  const ctx = {
    mode: "tui",
    hasUI: true,
    cwd,
    sessionManager: { getSessionId: () => "test-session" },
    hasPendingMessages: () => state.pending,
    ui: {
      setStatus: (k: string, v: string | undefined) => status.set(k, v),
      setWidget: (k: string, v: any) => (v ? widgets.set(k, v) : widgets.delete(k)),
      notify: (m: string) => notes.push(m),
      setWorkingMessage: (m?: string) => working.push(m),
      select: async () => undefined,
      pasteToEditor: () => {},
    },
  };
  /** The widget's current lines, rendered at `width` with a plain theme. */
  const widgetLines = (key = "pi-bg", width = 200): string[] | undefined => {
    const factory = widgets.get(key);
    if (!factory) return undefined;
    const theme = { fg: (_c: string, t: string) => t, bold: (t: string) => t };
    return factory({ requestRender: () => {} }, theme).render(width);
  };
  return { ctx, status, notes, working, state, widgets, widgetLines };
}

export async function until(cond: () => boolean, ms = 5_000): Promise<void> {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error("timed out waiting for a condition");
    await new Promise((r) => setTimeout(r, 20));
  }
}
