import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { elapsed, footerStatus, marimoNote, nameFromCommand } from "../src/format.ts";
import { LogFollower, bounded, cleanLine, grep, head, tail } from "../src/log.ts";
import { type Task, parsePattern } from "../src/registry.ts";
import { MARIMO_READY, marimoName, marimoServer } from "../src/marimo.ts";

const task = (over: Partial<Task>): Task => ({
  id: "abc12",
  name: "tests",
  kind: "job",
  command: "npm test",
  cwd: "/tmp",
  logPath: "/tmp/x.log",
  startedAt: 0,
  status: "running",
  ready: false,
  keep: false,
  origin: "agent",
  delivered: false,
  readyDelivered: false,
  ...over,
});

describe("format", () => {
  it("elapsed", () => {
    expect(elapsed(45_000)).toBe("0:45");
    expect(elapsed(134_000)).toBe("2:14");
    expect(elapsed(3_900_000)).toBe("1h05m");
  });

  it("names a task from its command", () => {
    expect(nameFromCommand("cd ~/x && FOO=1 npm run test -- --watch")).toBe("npm run test");
    expect(nameFromCommand("pytest")).toBe("pytest");
    expect(nameFromCommand("for i in 1 2 3; do echo $i; done")).toBe("for i in 1 2 3; do echo $i;…");
  });

  it("footer: running jobs, services, then recent ends", () => {
    const now = 200_000;
    const s = footerStatus(
      [
        task({ name: "lint", status: "failed", endedAt: now - 10_000, exitCode: 1 }),
        task({ name: "vite", kind: "service", ready: true }),
        task({ name: "tests", startedAt: now - 134_000 }),
        task({ name: "old", status: "done", endedAt: now - 120_000 }),
      ],
      now,
    );
    expect(s).toBe("bg: tests 2:14 · vite ready · lint ✗");
    expect(footerStatus([], now)).toBeUndefined();
  });

  it("marimo note only for marimo-pair commands", () => {
    expect(marimoNote("bash .agents/skills/marimo-pair/scripts/execute-code.sh --url x -c 1")).toMatch(/kernel/);
    expect(marimoNote("npm test")).toBeUndefined();
  });
});

describe("log", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-bg-log-"));
  const file = path.join(dir, "a.log");
  fs.writeFileSync(file, `\x1b[32mgreen\x1b[0m\n10%\r50%\r100%\nERROR one\nok\nerror two\n${"x".repeat(1000)}\n`);

  it("cleans lines", () => {
    expect(cleanLine("\x1b[1mbold\x1b[0m")).toBe("bold");
    expect(cleanLine("10%\r50%\r100%")).toBe("100%");
    expect(cleanLine("crlf\r")).toBe("crlf");
  });

  it("tail, head, grep", () => {
    expect(head(file, 2)).toEqual(["green", "100%"]);
    expect(tail(file, 2)[0]).toBe("error two");
    expect(tail(file, 1)[0]?.endsWith("…")).toBe(true);
    expect(grep(file, parsePattern("error"), 10)).toEqual(["ERROR one", "error two"]);
    expect(grep(file, parsePattern("/error/"), 10)).toEqual(["error two"]);
  });

  it("a log that only redraws one line with \\r still shows it; escapes from tput are stripped", () => {
    const f = path.join(dir, "cr.log");
    fs.writeFileSync(f, Array.from({ length: 60_000 }, (_, i) => `\r${i}%`).join(""));
    expect(tail(f, 3)).toEqual(["59999%"]);
    expect(cleanLine("\x1b(Bplain\x1b=")).toBe("plain");
  });

  it("follows a growing file", () => {
    const f = path.join(dir, "b.log");
    fs.writeFileSync(f, "one\ntw");
    const follower = new LogFollower(f);
    expect(follower.read()).toEqual(["one"]);
    fs.appendFileSync(f, "o\nthree");
    expect(follower.read()).toEqual(["two"]);
    expect(follower.flush()).toEqual(["three"]);
  });

  it("bounds output from the end", () => {
    const r = bounded(["aaaa", "bbbb", "cccc"], 10);
    expect(r).toEqual({ text: "bbbb\ncccc", dropped: 1 });
  });
});

describe("marimo servers", () => {
  it("finds the mode and the notebook in the usual spellings", () => {
    expect(marimoServer("marimo edit nb.py")).toEqual({ mode: "edit", file: "nb.py" });
    expect(marimoServer("uv run marimo edit --no-token --port 2719 notebooks/fit.py")).toEqual({ mode: "edit", file: "notebooks/fit.py" });
    expect(marimoServer("cd x && uvx marimo run app.py --headless")).toEqual({ mode: "run", file: "app.py" });
    expect(marimoServer("python -m marimo edit")).toEqual({ mode: "edit" });
    expect(marimoServer(".venv/bin/marimo -q edit 'a b.py'")?.mode).toBe("edit");
    expect(marimoServer("marimo export html nb.py")).toBeUndefined();
    expect(marimoServer("npm run dev")).toBeUndefined();
    expect(marimoName({ mode: "edit", file: "notebooks/fit.py" })).toBe("marimo fit.py");
    expect(marimoName({ mode: "edit" })).toBe("marimo edit");
  });
  it("is ready on marimo's URL line", () => {
    const re = parsePattern(MARIMO_READY);
    expect(re.test("        ➜  URL: http://localhost:2718?access_token=abc")).toBe(true);
    expect(re.test("        ➜  Network: http://192.168.1.2:2718")).toBe(false);
  });
});
