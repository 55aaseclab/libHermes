import { spawn } from "node:child_process";
import { LearningError } from "../../protocol/validation.js";

export interface CommandOptions {
  cwd: string;
  signal: AbortSignal;
  timeoutMs: number;
  env?: NodeJS.ProcessEnv;
  input?: string;
}

export function command(executable: string, args: string[], options: CommandOptions): Promise<string> {
  options.signal.throwIfAborted();
  return new Promise((resolve, reject) => {
    const child = spawn(executable, args, {
      cwd: options.cwd, env: { ...(options.env ?? process.env), PWD: options.cwd }, shell: false,
      detached: process.platform !== "win32", stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let size = 0;
    let failure: Error | undefined;
    const kill = () => {
      try {
        if (process.platform !== "win32" && child.pid) process.kill(-child.pid, "SIGKILL");
        else child.kill("SIGKILL");
      } catch { child.kill("SIGKILL"); }
    };
    const abort = () => { failure = new LearningError("CANCELLED", "OpenCode execution cancelled"); kill(); };
    const timer = setTimeout(() => { failure = new LearningError("TIMEOUT", "OpenCode execution exceeded its time budget"); kill(); }, options.timeoutMs);
    options.signal.addEventListener("abort", abort, { once: true });
    const cleanup = () => { clearTimeout(timer); options.signal.removeEventListener("abort", abort); };
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      size += Buffer.byteLength(chunk);
      if (size > 2_000_000) { failure = new LearningError("OUTPUT_LIMIT", "OpenCode output exceeded limit"); kill(); }
      else stdout += chunk;
    });
    child.stderr.on("data", (buffer: Buffer) => {
      size += buffer.length;
      if (size > 2_000_000) { failure = new LearningError("OUTPUT_LIMIT", "OpenCode output exceeded limit"); kill(); }
    });
    child.on("error", error => { cleanup(); reject(error); });
    child.on("close", code => {
      cleanup();
      if (failure) reject(failure);
      else if (code !== 0) reject(new LearningError("PROCESS_FAILED", `OpenCode exited with code ${code}; raw stderr omitted to avoid credential leakage`));
      else resolve(stdout);
    });
    child.stdin.on("error", () => {});
    child.stdin.end(options.input ?? "");
    if (options.signal.aborted) abort();
  });
}
