import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { tail } from "../src/log.ts";
import { Registry, type TaskEvent, groupAlive } from "../src/registry.ts";
import { until } from "./fake.ts";

let dir: string;
beforeAll(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-bg-reg-"));
  process.env.PI_BG_DIR = dir;
});
afterAll(() => {
  delete process.env.PI_BG_DIR;
});

const base = { sessionId: "s1", origin: "agent" as const };

describe("registry", () => {
  it("runs a job to completion with its output in the log", async () => {
    const reg = new Registry();
    const events: TaskEvent["type"][] = [];
    reg.subscribe((e) => events.push(e.type));
    const t = reg.start({ ...base, command: "echo hello; echo err >&2", name: "hi", kind: "job", cwd: dir });
    await until(() => t.status !== "running");
    expect(t.status).toBe("done");
    expect(t.exitCode).toBe(0);
    expect(tail(t.logPath, 5)).toEqual(["hello", "err"]);
    expect(events).toEqual(["start", "end"]);
  });

  it("reports a failing job", async () => {
    const reg = new Registry();
    const t = reg.start({ ...base, command: "exit 3", name: "fail", kind: "job", cwd: dir });
    await until(() => t.status !== "running");
    expect(t.status).toBe("failed");
    expect(t.exitCode).toBe(3);
  });

  it("sees a service's ready line, then kills its whole process group", async () => {
    const reg = new Registry();
    const t = reg.start({ ...base, command: "sleep 30 & echo 'Listening on :3000'; wait", name: "srv", kind: "service", cwd: dir, ready: "listening on" });
    await until(() => t.ready, 4_000);
    expect(t.readyLine).toBe("Listening on :3000");
    expect(groupAlive(t.pid as number)).toBe(true);
    await reg.kill(t.id, "agent");
    expect(t.status).toBe("killed");
    await until(() => !groupAlive(t.pid as number), 2_000);
  });

  it("times a job out", async () => {
    const reg = new Registry();
    const t = reg.start({ ...base, command: "sleep 30", name: "slow", kind: "job", cwd: dir, timeoutSec: 0.3 });
    await until(() => t.status !== "running", 5_000);
    expect(t.status).toBe("timeout");
  });

  it("finds tasks by id, prefix or name", async () => {
    const reg = new Registry();
    const t = reg.start({ ...base, command: "true", name: "named", kind: "job", cwd: dir });
    expect(reg.find(t.id)).toBe(t);
    expect(reg.find("named")).toBe(t);
    expect(reg.find(t.id.slice(0, 4))).toBe(t);
    await until(() => t.status !== "running");
  });

  it("a later pi adopts kept services under its cwd and kills a crashed pi's orphans, checking each pid still runs our command", async () => {
    const a = new Registry();
    const kept = a.start({ ...base, command: "sleep 31", name: "kept", kind: "service", cwd: dir, keep: true });
    const orphan = a.start({ ...base, command: "sleep 32", name: "orphan", kind: "job", cwd: dir });
    const other = a.start({ ...base, command: "sleep 33", name: "other", kind: "job", cwd: dir });
    // Pretend the owner crashed: move its state file to a dead pid's name, and make one entry's
    // command not match what its pid runs (as if the pid had been reused).
    const own = path.join(dir, "state", `${process.pid}.json`);
    const entries = JSON.parse(fs.readFileSync(own, "utf8")).map((e: any) => (e.name === "other" ? { ...e, command: "something else entirely" } : e));
    fs.rmSync(own);
    fs.writeFileSync(path.join(dir, "state", "999999.json"), JSON.stringify(entries));
    const b = new Registry();
    const adopted = b.sweep(dir);
    expect(adopted.map((t) => t.name)).toEqual(["kept"]);
    await until(() => !groupAlive(orphan.pid as number), 3_000);
    expect(groupAlive(kept.pid as number)).toBe(true);
    // Not ours any more: left alone.
    expect(groupAlive(other.pid as number)).toBe(true);
    expect(fs.existsSync(path.join(dir, "state", "999999.json"))).toBe(false);
    await b.kill(kept.id, "user");
    expect(b.tasks.get(kept.id)?.status).toBe("killed");
    await a.kill(other.id, "user");
    await until(() => a.tasks.get(kept.id)?.status !== "running" && a.tasks.get(orphan.id)?.status !== "running");
  });

  it("a pi that quits leaves its kept services released, for any later pi under that cwd", async () => {
    const a = new Registry();
    const kept = a.start({ ...base, command: "sleep 34", name: "kept2", kind: "service", cwd: dir, keep: true });
    a.release();
    const own = path.join(dir, "state", `${process.pid}.json`);
    expect(JSON.parse(fs.readFileSync(own, "utf8"))).toMatchObject([{ name: "kept2", released: true }]);
    // The same pid looks alive, but released entries are adoptable anyway.
    fs.renameSync(own, path.join(dir, "state", `${process.ppid}.json`));
    const b = new Registry();
    expect(b.sweep(dir).map((t) => t.name)).toEqual(["kept2"]);
    await b.kill(kept.id, "user");
    await until(() => a.tasks.get(kept.id)?.status !== "running");
  });

  it("an exit 0 that races a stop still reads as done; processes the shell left behind die at session end", async () => {
    const reg = new Registry();
    const t = reg.start({ ...base, command: "sleep 30 & exit 0", name: "leaves", kind: "job", cwd: dir });
    await until(() => t.status !== "running");
    expect(t.status).toBe("done");
    expect(t.strays).toBe(true);
    expect(groupAlive(t.pid as number)).toBe(true);
    await reg.killAll("session");
    await until(() => !groupAlive(t.pid as number), 3_000);
  });
});

describe("registry across a reload and over time", () => {
  it("a registry from an earlier load shares its state: old exit handlers reach new listeners", async () => {
    const old = new Registry();
    const t = old.start({ ...base, command: "sleep 0.5", name: "spans", kind: "job", cwd: dir });
    const next = new Registry();
    next.adopt(old);
    const seen: string[] = [];
    next.subscribe((e) => seen.push(`${e.type}:${e.task.name}`));
    expect(next.find("spans")).toBe(t);
    await until(() => t.status !== "running", 3_000);
    expect(seen).toEqual(["end:spans"]);
  });

  it("a running log past the cap is cut back to its tail", async () => {
    const reg = new Registry();
    const t = reg.start({ ...base, command: "for i in $(seq 1 400); do echo line-$i; done; sleep 3", name: "chatty", kind: "job", cwd: dir });
    await until(() => (tail(t.logPath, 1)[0] ?? "") === "line-400", 3_000);
    reg.capLogs(1_000, 200);
    const lines = tail(t.logPath, 100);
    expect(lines[0]).toMatch(/^\[pi-bg\] log cut at /u);
    // The task keeps appending after the cut.
    expect(lines.at(-1)).toBe("line-400");
    expect(fs.statSync(t.logPath).size).toBeLessThan(300);
    await reg.kill(t.id, "agent");
  });
});
