// marimo, without pi-marimo: a `marimo edit` or `marimo run` server started with bg_run is named
// after its notebook and is ready when marimo prints its URL. pi-marimo, when installed, adds the
// kernel's state to the task through `bg:annotate` (index.ts).

/** What marimo prints once it serves: `➜  URL: http://localhost:2718?access_token=...`. */
export const MARIMO_READY = "URL:\\s*https?://";

/**
 * A marimo server command (`marimo edit nb.py`, `uv run marimo edit --no-token nb.py`,
 * `uvx marimo run app.py`, `python -m marimo edit`): its mode and its notebook, when one is named.
 */
export function marimoServer(command: string): { mode: "edit" | "run"; file?: string } | undefined {
  const m = /(?:^|[\s;&|(/])marimo\s+(?:-\S+\s+)*(edit|run)\b([^;&|]*)/u.exec(command);
  if (!m) return undefined;
  const file = (m[2] ?? "").split(/\s+/u).find((w) => /\.(?:py|md)$/u.test(w) && !w.startsWith("-"));
  return { mode: m[1] as "edit" | "run", ...(file ? { file: file.replace(/^["']|["']$/gu, "") } : {}) };
}

/** A task's name: `marimo fit.py`, or `marimo edit` for a server over a directory. */
export function marimoName(server: { mode: "edit" | "run"; file?: string }): string {
  return server.file ? `marimo ${server.file.split("/").pop()}` : `marimo ${server.mode}`;
}
