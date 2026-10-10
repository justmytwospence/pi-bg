import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { fakeCtx, fakePi, until } from "./fake.ts";

let dir: string;
beforeAll(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-bg-ext-"));
  process.env.PI_BG_DIR = dir;
});
afterAll(() => {
  delete process.env.PI_BG_DIR;
});

async function load() {
  const { default: piBg } = await import("../src/index.ts");
  const f = fakePi();
  piBg(f.pi as any);
  const c = fakeCtx(dir);
  for (const h of f.handlers.get("session_start") ?? []) await h({ reason: "startup" }, c.ctx);
  const call = (tool: string, params: any, signal?: AbortSignal) => f.tools.get(tool).execute("call", params, signal, undefined, c.ctx);
  const shutdown = async (reason = "quit") => {
    for (const h of f.handlers.get("session_shutdown") ?? []) await h({ reason }, c.ctx);
  };
  const textOf = (r: any) => r.content.map((p: any) => p.text).join("\n");
  return { ...f, ...c, call, shutdown, textOf };
}

describe("pi-bg", () => {
  it("reports a command that fails at once in bg_run's own result", async () => {
    const x = await load();
    const r = x.textOf(await x.call("bg_run", { command: "echo nope; exit 2", kind: "job", name: "bad" }));
    expect(r).toMatch(/ended at once/);
    expect(r).toMatch(/exit 2/);
    expect(r).toMatch(/nope/);
    await x.shutdown();
    expect(x.sent).toEqual([]);
  });

  it("wakes the agent when a job ends, holding herdr:background meanwhile", async () => {
    const x = await load();
    const r = x.textOf(await x.call("bg_run", { command: "sleep 2; echo built", kind: "job", name: "build" }));
    expect(r).toMatch(/Started build/);
    const hold = x.emitted.find((e) => e.channel === "herdr:background" && e.data.active);
    expect(hold?.data.label).toBe("build");
    // The widget, not the footer status, shows it in the TUI.
    expect(x.status.get("bg")).toBeUndefined();
    const lines = x.widgetLines() ?? [];
    expect(lines[0]).toBe("● Background  1 running");
    expect(lines[1]).toMatch(/^└─ \S build  job · 0:0\d · sleep 2; echo built$/u);
    await until(() => x.sent.length > 0, 5_000);
    const wake = x.sent[0];
    expect(wake?.options).toEqual({ triggerTurn: true, deliverAs: "followUp" });
    expect(wake?.message.content).toMatch(/Background job build .* ended: exit 0/);
    expect(wake?.message.content).toMatch(/built/);
    expect(x.emitted.some((e) => e.channel === "herdr:background" && e.data.active === false && e.data.id === hold?.data.id)).toBe(true);
    await x.shutdown();
  });

  it("bg_wait returns the outcome in the turn, with no wake-up", async () => {
    const x = await load();
    await x.call("bg_run", { command: "sleep 2; echo done-waiting", kind: "job", name: "w" });
    const r = x.textOf(await x.call("bg_wait", {}));
    expect(r).toMatch(/exit 0/);
    expect(r).toMatch(/done-waiting/);
    expect(x.working.some((m) => m?.startsWith("Waiting on w"))).toBe(true);
    expect(x.working.at(-1)).toBeUndefined();
    await new Promise((res) => setTimeout(res, 200));
    expect(x.sent).toEqual([]);
    await x.shutdown();
  });

  it("bg_wait stops when the user sends a message; the job still wakes the agent later", async () => {
    const x = await load();
    await x.call("bg_run", { command: "sleep 2", kind: "job", name: "long" });
    setTimeout(() => {
      x.state.pending = true;
    }, 300);
    const r = x.textOf(await x.call("bg_wait", { id: "long" }));
    expect(r).toMatch(/a message arrived for you/);
    expect(r).toMatch(/Still running: long/);
    x.state.pending = false;
    await until(() => x.sent.length > 0, 5_000);
    expect(x.sent[0]?.message.content).toMatch(/long/);
    await x.shutdown();
  });

  it("wakes the agent once when a service is ready, and bg_kill stops it without a wake-up", async () => {
    const x = await load();
    const r = x.textOf(await x.call("bg_run", { command: "sleep 2; echo 'ready on :8000'; sleep 30", kind: "service", name: "srv", ready: "ready on" }));
    expect(r).toMatch(/woken once/);
    expect(x.emitted.some((e) => e.channel === "herdr:background")).toBe(false);
    await until(() => x.sent.length > 0, 5_000);
    expect(x.sent[0]?.message.content).toMatch(/srv .* is ready: ready on :8000/);
    const k = x.textOf(await x.call("bg_kill", { id: "srv" }));
    expect(k).toMatch(/Stopped srv/);
    expect(x.emitted.some((e) => e.channel === "bg:killed")).toBe(true);
    await new Promise((res) => setTimeout(res, 200));
    expect(x.sent.length).toBe(1);
    await x.shutdown();
  });

  it("bg_logs lists and greps; bg_wait waits on outside work", async () => {
    const x = await load();
    await x.call("bg_run", { command: "printf 'a\\nERROR b\\nc\\n'; sleep 2", kind: "job", name: "logs" });
    const list = x.textOf(await x.call("bg_logs", {}));
    expect(list).toMatch(/logs {2}job {2}running/);
    const g = x.textOf(await x.call("bg_logs", { id: "logs", grep: "error" }));
    expect(g).toMatch(/1 lines matching error:\nERROR b/);
    x.pi.events.emit("bg:external", { id: "marimo:fit.py", label: "fit.py", state: "running" });
    setTimeout(() => x.pi.events.emit("bg:external", { id: "marimo:fit.py", label: "fit.py", state: "done", summary: "ran 0:01" }), 300);
    const w = x.textOf(await x.call("bg_wait", { id: "marimo:fit.py" }));
    expect(w).toBe("fit.py (marimo:fit.py): done · ran 0:01");
    await x.shutdown();
  });

  it("the widget shows the waiting tag and the latest log line; /bg widget off brings back the footer status", async () => {
    const x = await load();
    await x.call("bg_run", { command: "echo first; echo second; sleep 2", kind: "job", name: "tagged" });
    const waiting = x.call("bg_wait", { id: "tagged" });
    await until(() => (x.widgetLines() ?? []).some((l) => l.includes("waiting")), 2_000);
    const lines = x.widgetLines() ?? [];
    expect(lines[1]).toMatch(/tagged {2}job · 0:0\d · waiting · echo first/u);
    expect(lines[2]).toBe("     ⎿  second");
    await waiting;
    expect(x.widgetLines()?.[1]).toMatch(/^└─ ✓ tagged {2}exit 0 after 0:0\d$/u);
    await x.commands.get("bg").handler("widget off", x.ctx);
    expect(x.widgets.has("pi-bg")).toBe(false);
    expect(x.status.get("bg")).toMatch(/^bg: tagged ✓$/u);
    await x.commands.get("bg").handler("widget on", x.ctx);
    expect(x.status.get("bg")).toBeUndefined();
    await x.shutdown();
  });

  it("a double-click on a task's row opens its log", async () => {
    const x = await load();
    await x.call("bg_run", { command: "sleep 3", kind: "job", name: "clicky" });
    const w = x.widgetComponent();
    w.render(120);
    const click = (y: number, clickCount: number) => w.handleMouse({ type: "click", button: "left", x: 5, y, clickCount, screenX: 0, screenY: 0, width: 120, height: 4, shift: false, alt: false, ctrl: false });
    expect(click(1, 1)).toBeUndefined();
    expect(click(0, 2)).toBeUndefined(); // the header
    // A press on a row is taken, so pi turns its release into a click for this widget.
    expect(w.handleMouse({ type: "press", button: "left", x: 5, y: 1, screenX: 0, screenY: 0, width: 120, height: 4, shift: false, alt: false, ctrl: false })).toEqual({ handled: true, render: false });
    expect(click(2, 2)).toEqual({ handled: true }); // the log line belongs to the task too
    expect(x.opened).toHaveLength(1);
    await x.shutdown();
  });

  it("with an activity host (pi-subagents), its rows become a section of the host's panel", async () => {
    const { ACTIVITY_HOST, ACTIVITY_SECTION } = await import("../src/activity.ts");
    const x = await load();
    const offered = x.emitted.filter((e) => e.channel === ACTIVITY_SECTION);
    expect(offered).toHaveLength(1);
    const section = offered[0]?.data.section;
    // A host that loads later asks again.
    x.pi.events.emit(ACTIVITY_HOST, {});
    expect(x.emitted.filter((e) => e.channel === ACTIVITY_SECTION)).toHaveLength(2);
    section.setHosted(true);
    await x.call("bg_run", { command: "echo out; sleep 3", kind: "job", name: "hosted" });
    expect(x.widgets.has("pi-bg")).toBe(false);
    expect(x.status.get("bg")).toBeUndefined();
    expect(x.emitted.some((e) => e.channel === "activity:changed")).toBe(true);
    const theme = { fg: (_c: string, t: string) => t, bold: (t: string) => t };
    const r = section.render({ width: 120, theme, now: Date.now(), frame: 0, maxLines: 4 });
    expect(r.lines[0]).toBe("● Background  1 running");
    expect(r.lines[1]).toMatch(/^└─ ⠋ hosted {2}job · 0:0\d · echo out; sleep 3$/u);
    expect(r.targets).toEqual([undefined, expect.any(String), expect.any(String)]);
    const entries = section.entries(Date.now());
    expect(entries).toMatchObject([{ label: "hosted", detail: "echo out; sleep 3", status: "running" }]);
    await section.open(entries[0].key, x.ctx.ui);
    expect(x.opened).toHaveLength(1);
    section.stop(entries[0].key);
    await until(() => section.entries(Date.now())[0]?.status === "stopped", 5_000);
    // The host goes away: our own widget is back.
    section.setHosted(false);
    expect(x.widgets.has("pi-bg")).toBe(true);
    await x.shutdown();
    expect(x.emitted.some((e) => e.channel === "activity:gone")).toBe(true);
  });

  it("kills its tasks when the session ends, but not on reload", async () => {
    const x = await load();
    await x.call("bg_run", { command: "sleep 30", kind: "job", name: "a" });
    await x.shutdown("reload");
    const { registry } = await import("../src/registry.ts");
    const t = registry().find("a");
    expect(t?.status).toBe("running");
    for (const h of x.handlers.get("session_start") ?? []) await h({ reason: "reload" }, x.ctx);
    await x.shutdown("quit");
    expect(t?.status).toBe("killed");
    expect(x.sent).toEqual([]);
  });
});
