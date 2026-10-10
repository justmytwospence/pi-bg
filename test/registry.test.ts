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

  it("a later pi adopts kept services under its cwd and kills a crashed pi's orphans", async () => {
    const a = new Registry();
    const kept = a.start({ ...base, command: "sleep 30", name: "kept", kind: "service", cwd: dir, keep: true });
    const orphan = a.start({ ...base, command: "sleep 30", name: "orphan", kind: "job", cwd: dir });
    // Pretend the owner crashed: rewrite state.json with a dead owner pid.
    const state = path.join(dir, "state.json");
    const entries = JSON.parse(fs.readFileSync(state, "utf8")).map((e: any) => ({ ...e, owner: 999_999 }));
    fs.writeFileSync(state, JSON.stringify(entries));
    const b = new Registry();
    const adopted = b.sweep(dir);
    expect(adopted.map((t) => t.name)).toEqual(["kept"]);
    await until(() => !groupAlive(orphan.pid as number), 3_000);
    expect(groupAlive(kept.pid as number)).toBe(true);
    await b.kill(kept.id, "user");
    expect(b.tasks.get(kept.id)?.status).toBe("killed");
    await until(() => a.tasks.get(kept.id)?.status !== "running" && a.tasks.get(orphan.id)?.status !== "running");
  });
});
