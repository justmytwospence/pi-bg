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
    // The pill under the prompt, not a footer status, shows it in the TUI.
    expect(x.status.get("bg")).toBeUndefined();
    expect(x.widgetLines()).toEqual(["  1 shell "]);
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
    expect(r).toMatch(/user sent a message/);
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

  it("the pill: 1 shell, then the failure in the error color until the next message; ↓ Enter opens the dialog", async () => {
    const x = await load();
    await x.call("bg_run", { command: "sleep 2; echo bad; exit 3", kind: "job", name: "flaky" });
    expect(x.widgetLines()).toEqual(["  1 shell "]);
    // ↓ at an empty prompt selects it; Enter opens the dialog.
    expect(x.press("\x1b[B")).toBe(true);
    expect(x.widgetLines()?.[0]).toBe(" [ 1 shell ]  enter to view · esc to go back");
    expect(x.press("\r")).toBe(true);
    expect(x.opened).toHaveLength(1);
    const dialog = x.overlay(0);
    const lines: string[] = dialog.render(100);
    expect(lines[0]).toContain("◀ esc · Background tasks · not your main session");
    expect(lines[1]).toContain("1 running · 0 ended");
    // It covers the screen.
    expect(lines).toHaveLength(40);
    expect(lines.join("\n")).toMatch(/Shells · 1 running[^\n]*\n[^\n]*❯ ● flaky  sleep 2; echo bad; exit 3 +0:0\d/u);
    dialog.handleInput("\x1b");
    await until(() => x.sent.length > 0, 5_000);
    // Failed: the pill keeps a red count until the user's next message.
    expect(x.widgetLines()).toEqual(["  shells  · 1 failed"]);
    for (const h of x.handlers.get("input") ?? []) await h({ source: "interactive", text: "ok" }, x.ctx);
    expect(x.widgets.has("pi-bg-pill")).toBe(false);
    await x.shutdown();
  });

  it("the dialog: the waiting tag, enter opens the log and comes back, x stops (twice), x dismisses an ended task", async () => {
    const x = await load();
    await x.call("bg_run", { command: "echo one; sleep 3", kind: "job", name: "slow" });
    const waiting = x.call("bg_wait", { id: "slow", timeout: 1 });
    await new Promise((r) => setTimeout(r, 300));
    void x.commands.get("tasks").handler("", x.ctx);
    await until(() => x.opened.length === 1);
    let dialog = x.overlay(0);
    expect(dialog.render(100).join("\n")).toMatch(/slow  echo one; sleep 3 +waiting · 0:0\d/u);
    await waiting;
    // Enter: the log viewer; when it closes, the dialog again on the same task.
    dialog.handleInput("\r");
    await until(() => x.opened.length === 2);
    const viewer = x.overlay(1);
    expect(viewer.render(100).join("\n")).toContain("one");
    viewer.handleInput("\x1b");
    await until(() => x.opened.length === 3);
    dialog = x.overlay(2);
    expect(dialog.render(100).join("\n")).toContain("❯ ● slow");
    dialog.handleInput("x");
    expect(dialog.render(100).at(-2)).toContain("x again to stop slow");
    dialog.handleInput("x");
    await until(() => dialog.render(100).join("\n").includes("■ slow"), 5_000);
    expect(dialog.render(100).at(-2)).toContain("x dismiss");
    dialog.handleInput("x");
    expect(dialog.render(100).join("\n")).toContain("No tasks currently running");
    dialog.handleInput("\x1b");
    await x.shutdown();
  }, 15_000);

  it("another source that throws cannot break the dialog: its rows are left out, its view failing returns to the list", async () => {
    const { ACTIVITY_SECTION } = await import("../src/activity.ts");
    const x = await load();
    await x.call("bg_run", { command: "sleep 3", kind: "job", name: "mine" });
    let broken = true;
    const flaky = {
      id: "subagents",
      title: "subagents",
      entries: () => {
        if (broken) throw new Error("boom");
        return [{ key: "r1", label: "scout", detail: "look", status: "running", stats: "1s", startedAt: 0 }];
      },
      open: async () => {
        throw new Error("no view");
      },
      stop: () => {
        throw new Error("no stop");
      },
    };
    x.pi.events.emit(ACTIVITY_SECTION, { section: flaky });
    void x.commands.get("tasks").handler("", x.ctx);
    await until(() => x.opened.length === 1);
    expect(x.overlay(0).render(100).join("\n")).toContain("mine");
    broken = false;
    const dialog = x.overlay(0);
    dialog.handleInput("\x1b[B");
    dialog.handleInput("x");
    dialog.handleInput("x");
    dialog.handleInput("\r");
    // The failed view returns to the dialog.
    await until(() => x.opened.length === 2);
    x.overlay(1).handleInput("\x1b");
    await x.shutdown();
  });

  it("a click on the pill opens the dialog", async () => {
    const x = await load();
    await x.call("bg_run", { command: "sleep 3", kind: "job", name: "clicky" });
    const w = x.widgetComponent();
    w.render(120);
    const mouse = (type: string) => w.handleMouse({ type, button: "left", x: 3, y: 0, clickCount: 1, screenX: 0, screenY: 0, width: 120, height: 1, shift: false, alt: false, ctrl: false });
    // A press is taken, so pi turns its release into a click for this widget.
    expect(mouse("press")).toEqual({ handled: true, render: false });
    expect(mouse("click")).toEqual({ handled: true });
    expect(x.opened).toHaveLength(1);
    await x.shutdown();
  });

  it("with pi-subagents: hosted, it draws no pill; its source lists, opens, stops and dismisses; the dialog lists other sources", async () => {
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
    expect(x.widgets.has("pi-bg-pill")).toBe(false);
    expect(x.status.get("bg")).toBeUndefined();
    expect(x.emitted.some((e) => e.channel === "activity:changed")).toBe(true);
    expect(section.pill(Date.now())).toEqual({ label: "1 shell" });
    const entries = section.entries(Date.now());
    expect(entries).toMatchObject([{ label: "hosted", detail: "echo out; sleep 3", status: "running" }]);
    // Another source (pi-subagents' runs) shows in the dialog under its own heading.
    const runs = { id: "subagents", title: "subagents", entries: () => [{ key: "r1", label: "scout", detail: "look around", status: "running", stats: "12s", startedAt: 0 }], open: async () => {} };
    x.pi.events.emit(ACTIVITY_SECTION, { section: runs });
    void section.openDialog(x.ctx.ui);
    const text = x.overlay(0).render(100).join("\n");
    expect(text).toMatch(/Shells · 1 running[\s\S]*Subagents · 1 running[\s\S]*● scout  look around/u);
    x.overlay(0).handleInput("\x1b");
    section.stop(entries[0].key);
    await until(() => section.entries(Date.now())[0]?.status === "stopped", 5_000);
    section.dismiss(entries[0].key);
    expect(section.entries(Date.now())).toEqual([]);
    // The host goes away: our own pill is back when there is something to show.
    section.setHosted(false);
    await x.call("bg_run", { command: "sleep 3", kind: "job", name: "again" });
    expect(x.widgets.has("pi-bg-pill")).toBe(true);
    await x.shutdown();
    expect(x.emitted.some((e) => e.channel === "activity:gone")).toBe(true);
  });

  it("a wake-up waits while the agent works (Esc would drop a queued one), then goes out once it settles; bg_logs meanwhile delivers it", async () => {
    const x = await load();
    // The agent's turn is running (it is calling tools).
    x.state.busy = true;
    await x.call("bg_run", { command: "sleep 1.7; echo a", kind: "job", name: "first" });
    await x.call("bg_run", { command: "sleep 1.8; echo b", kind: "job", name: "second" });
    await new Promise((r) => setTimeout(r, 2_000));
    expect(x.sent).toEqual([]);
    // The agent reads one log itself; only the other is still owed.
    await x.call("bg_logs", { id: "first" });
    x.state.busy = false;
    for (const h of x.handlers.get("agent_settled") ?? []) await h({}, x.ctx);
    expect(x.sent).toHaveLength(1);
    expect(x.sent[0]?.message.content).toMatch(/second/u);
    expect(x.sent[0]?.message.content).not.toMatch(/Background job first/u);
    await x.shutdown();
  }, 15_000);

  it("a job that ends during a reload wakes the agent once the new session is up", async () => {
    const x = await load();
    await x.call("bg_run", { command: "sleep 2", kind: "job", name: "across" });
    await x.shutdown("reload");
    await new Promise((r) => setTimeout(r, 1_000));
    expect(x.sent).toEqual([]);
    for (const h of x.handlers.get("session_start") ?? []) await h({ reason: "reload" }, x.ctx);
    await until(() => x.sent.length > 0, 2_000);
    expect(x.sent[0]?.message.content).toMatch(/Background job across .* ended: exit 0/u);
    await x.shutdown();
  });

  it("a service has no timeout", async () => {
    const x = await load();
    await expect(x.call("bg_run", { command: "true", kind: "service", timeout: 5 })).rejects.toThrow(/timeout. is for jobs/u);
    await x.shutdown();
  });

  it("bg_wait without an id waits for the agent's jobs only, and bg_run checks its cwd", async () => {
    const x = await load();
    await x.commands.get("tasks").handler("run sleep 3", x.ctx);
    expect(x.textOf(await x.call("bg_wait", {}))).toMatch(/^Nothing to wait for/u);
    await x.call("bg_run", { command: "sleep 2.5; echo mine", kind: "job", name: "mine" });
    const r = x.textOf(await x.call("bg_wait", {}));
    expect(r).toMatch(/mine \(job/u);
    await expect(x.call("bg_run", { command: "true", kind: "job", cwd: "/no/such/dir" })).rejects.toThrow(/No such directory/u);
    await x.shutdown();
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
