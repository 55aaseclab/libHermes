import { spawn } from "node:child_process";
import { mkdtemp, open, readFile, rm, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { ensure, LearningError } from "../../protocol/validation.js";

export async function exportOpenCodeSession(sessionId: string, cwd: string, signal: AbortSignal): Promise<unknown> {
  ensure(/^ses_[a-zA-Z0-9]+$/.test(sessionId), "INVALID_INPUT", "Invalid OpenCode session ID");
  signal.throwIfAborted();
  const directory = await mkdtemp(path.join(os.tmpdir(), "cl-export-"));
  const filename = path.join(directory, "export.json");
  const file = await open(filename, "wx", 0o600);
  try {
    await new Promise<void>((resolve, reject) => {
      const child = spawn("opencode", ["export", "--pure", sessionId], {
        cwd, env: { ...process.env, PWD: cwd }, shell: false,
        stdio: ["ignore", file.fd, "ignore"], detached: process.platform !== "win32",
      });
      let failure: Error | undefined;
      const terminate = () => {
        try { if (process.platform !== "win32" && child.pid) process.kill(-child.pid, "SIGKILL"); else child.kill("SIGKILL"); }
        catch { child.kill("SIGKILL"); }
      };
      const cancel = () => { failure = new LearningError("CANCELLED", "Export cancelled"); terminate(); };
      const timer = setTimeout(() => { failure = new LearningError("TIMEOUT", "Export timed out"); terminate(); }, 30000);
      signal.addEventListener("abort", cancel, { once: true });
      const cleanup = () => { clearTimeout(timer); signal.removeEventListener("abort", cancel); };
      child.on("error", error => { cleanup(); reject(error); });
      child.on("close", code => { cleanup(); if (failure) reject(failure); else if (code !== 0) reject(new LearningError("EXPORT_FAILED", "OpenCode export failed")); else resolve(); });
      if (signal.aborted) cancel();
    });
    ensure((await stat(filename)).size <= 2_000_000, "INPUT_LIMIT", "Export is too large");
    return JSON.parse(await readFile(filename, "utf8")) as unknown;
  } finally {
    await file.close();
    await rm(directory, { recursive: true, force: true });
  }
}
