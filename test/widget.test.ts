import { describe, expect, it } from "vitest";
import type { Task } from "../src/registry.ts";
import { renderWidget, widgetTasks } from "../src/widget.ts";

const theme = { fg: (_c: string, t: string) => t, bold: (t: string) => t };
const task = (over: Partial<Task>): Task => ({
  id: "a1",
  name: "tests",
  kind: "job",
  command: "npm test",
  cwd: "/tmp",
  logPath: "/tmp/none.log",
  startedAt: 0,
  status: "running",
  ready: false,
  keep: false,
  origin: "agent",
  delivered: false,
  readyDelivered: false,
  ...over,
});

const frame = (tasks: Task[], now: number, waiting: string[] = [], dismissedAt = 0) =>
  renderWidget({ tasks: widgetTasks(tasks, now, dismissedAt), waiting: new Set(waiting), lastLine: (t) => `last of ${t.name}`, now, frame: 0, width: 120, theme });

describe("widget", () => {
  it("running jobs and services with their last line, then what ended", () => {
    const now = 134_000;
    const lines = frame(
      [
        task({ id: "a", name: "tests" }),
        task({ id: "b", name: "vite", kind: "service", ready: true, readyPattern: "Local", keep: true, startedAt: 100_000, command: "npm   run dev" }),
        task({ id: "c", name: "lint", status: "failed", exitCode: 1, startedAt: 120_000, endedAt: 130_000 }),
        task({ id: "d", name: "old", status: "done", exitCode: 0, endedAt: 100_000 }),
      ],
      now,
      ["a"],
    );
    expect(lines).toEqual([
      "● Background  1 running, 1 service",
      "├─ ⠋ tests  job · 2:14 · waiting · npm test",
      "│    ⎿  last of tests",
      "├─ ● vite  service · ready 0:34 · kept · npm run dev",
      "│    ⎿  last of vite",
      "└─ ✗ lint  exit 1 after 0:10 · last of lint",
      "",
    ]);
  });

  it("only what ended: dim header; empty: nothing", () => {
    expect(frame([task({ status: "done", exitCode: 0, startedAt: 0, endedAt: 5_000 })], 6_000)).toEqual(["○ Background", "└─ ✓ tests  exit 0 after 0:05", ""]);
    expect(frame([task({ status: "done", exitCode: 0, endedAt: 0 })], 60_000)).toEqual([]);
  });

  it("failures and stops stay until the user's next message, sharing one row", () => {
    const now = 600_000;
    const tasks = [
      task({ id: "a", name: "lint", status: "failed", exitCode: 1, startedAt: 0, endedAt: 100_000 }),
      task({ id: "b", name: "srv", kind: "service", status: "killed", killedBy: "agent", startedAt: 0, endedAt: 200_000 }),
      task({ id: "c", name: "slow", status: "timeout", timeoutSec: 5, startedAt: 0, endedAt: 300_000 }),
    ];
    expect(frame(tasks, now)).toEqual(["○ Background", "└─ ✗ slow  timed out after 5:00 · +2 more ended · last of slow", ""]);
    // A message after the first two ended: only the third is left.
    expect(frame(tasks, now, [], 250_000)).toEqual(["○ Background", "└─ ✗ slow  timed out after 5:00 · last of slow", ""]);
    expect(frame(tasks, now, [], 300_000)).toEqual([]);
  });

  it("too many rows collapse into +N more", () => {
    const tasks = Array.from({ length: 8 }, (_, i) => task({ id: `t${i}`, name: `job${i}` }));
    const lines = frame(tasks, 1_000);
    expect(lines.length).toBe(13); // 12 rows and the spacer
    expect(lines.at(-2)).toBe("└─ +3 more (3 running) · /bg");
  });
});
