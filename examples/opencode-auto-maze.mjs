import assert from "node:assert/strict";
import { cp, mkdir, readFile, writeFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = process.env.CL_AUTO_ROOT;
assert.ok(root && path.isAbsolute(root), "Set a fresh absolute CL_AUTO_ROOT");
const model = process.env.CL_OPENCODE_MODEL;
assert.ok(model, "Set CL_OPENCODE_MODEL");
const directory = path.join(root, "game");
await mkdir(directory, { recursive: true });
await cp("/tmp/cl-maze-20261015-fixed/game", directory, { recursive: true, filter: source => !source.includes(".opencode") });
await mkdir(path.join(directory, ".continual-learning"));
await writeFile(path.join(directory, ".continual-learning/config.json"), JSON.stringify({ enabled: true, allowNetwork: true, autoApprove: true, node: process.execPath, model }));
const plugin = fileURLToPath(new URL("../plugins/opencode/continual-learning.mjs", import.meta.url));
const permission = { "*": "deny", read: "allow", glob: "allow", grep: "allow", edit: "allow", write: "allow", bash: { "*": "deny", "node --test*": "allow", "node --check*": "allow" } };
await writeFile(path.join(directory, "opencode.json"), JSON.stringify({ plugin: [plugin], permission, share: "disabled", autoupdate: false }));
const port = Number(process.env.CL_AUTO_PORT ?? 41973);
const server = spawn("opencode", ["serve", "--port", String(port), "--hostname", "127.0.0.1"], { cwd: directory, env: { ...process.env, PWD: directory }, stdio: ["ignore", "pipe", "pipe"] });
server.stdout.on("data", chunk => process.stdout.write(chunk));
server.stderr.on("data", chunk => process.stderr.write(chunk));
const base = `http://127.0.0.1:${port}`;
const request = async (route, body) => {
  const response = await fetch(base + route, { method: body ? "POST" : "GET", headers: { "Content-Type": "application/json", "x-opencode-directory": directory }, ...(body ? { body: JSON.stringify(body) } : {}), signal: AbortSignal.timeout(240000) });
  assert.ok(response.ok, `${route}: ${response.status}`);
  return response.json();
};
const events = async () => {
  try { return (await readFile(path.join(directory, ".continual-learning/events.jsonl"), "utf8")).trim().split("\n").filter(Boolean).map(JSON.parse); }
  catch (error) { if (error.code === "ENOENT") return []; throw error; }
};
const waitReview = async sessionId => {
  for (let attempt = 0; attempt < 110; attempt++) {
    const rows = await events();
    assert.ok(!rows.some(row => row.type === "error" || row.type === "capture-error" || row.type === "worker-start-error"), JSON.stringify(rows));
    const result = rows.find(row => row.type === "reviewed" && row.sessionId === sessionId);
    if (result) return result;
    await new Promise(resolve => setTimeout(resolve, 2000));
  }
  throw new Error("Automatic review did not finish");
};
try {
  for (let attempt = 0; attempt < 60; attempt++) {
    try { const response = await fetch(base + "/global/health", { signal: AbortSignal.timeout(1500) }); if (response.ok) break; } catch {}
    await new Promise(resolve => setTimeout(resolve, 500));
  }
  const [providerID, ...modelParts] = model.split("/");
  const send = (session, text) => request(`/session/${session.id}/message`, { model: { providerID, modelID: modelParts.join("/") }, parts: [{ type: "text", text }] });
  const source = await request("/session", { title: "auto-maze-source" });
  await writeFile(path.join(root, "source-session.json"), JSON.stringify(source));
  const first = await send(source, "Maintain this maze game. Standing project convention: all future player-facing documentation must call blocked moves 'wall bumps', never 'invalid moves'. Add a brief README section explaining that wall bumps do not increase the step counter. Run node --test. Do not edit configuration or hidden files.");
  await writeFile(path.join(root, "round-1.json"), JSON.stringify(first, null, 2));
  console.log("TASK_COMPLETE", source.id);
  const firstReview = await waitReview(source.id);
  assert.equal(firstReview.status, "committed");
  console.log("AUTO_REVIEW_COMPLETE", firstReview);
  const next = await request("/session", { title: "auto-maze-fresh" });
  const second = await send(next, "Add a concise player-facing FAQ to README explaining what happens when a move is blocked and whether it counts as a step. Follow project conventions. Run node --test. Do not edit configuration or hidden files.");
  await writeFile(path.join(root, "round-2.json"), JSON.stringify(second, null, 2));
  assert.ok((await events()).some(row => row.type === "context-injected" && row.sessionId === next.id));
  const secondReview = await waitReview(next.id);
  const report = { source: source.id, reuse: next.id, firstReview, secondReview, events: await events() };
  await writeFile(path.join(root, "result.json"), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
} finally { server.kill("SIGTERM"); }
