import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { command } from "../packages/adapters/opencode/process.js";
import { parseRunOutput } from "../packages/adapters/opencode/index.js";
import { exportOpenCodeSession } from "../packages/adapters/opencode/export.js";

const model = process.env.CL_OPENCODE_MODEL;
const root = process.env.CL_MAZE_ROOT;
if (!model || !root) throw new Error("Set CL_OPENCODE_MODEL and CL_MAZE_ROOT");
const workspace = path.resolve(root, "game");
const artifacts = path.resolve(root, "artifacts");
const previous = JSON.parse(await readFile(path.join(artifacts, "state.json"), "utf8")) as { sessionId: string };
const permission = {
  "*": "deny", read: "allow", glob: "allow", grep: "allow", edit: "allow", write: "allow",
  bash: { "*": "deny", "node --test*": "allow", "node --check*": "allow" },
  skill: { "*": "deny", "continual-learning": "allow" }, external_directory: "deny",
};
const output = await command("opencode", ["run", "--dir", workspace, "--pure", "--format", "json", "--model", model,
  "--agent", "maze-maintainer", "--title", "maze-reuse-fresh-session"], {
  cwd: workspace, timeoutMs: 230000, signal: AbortSignal.timeout(240000),
  env: { ...process.env, OPENCODE_DISABLE_CLAUDE_CODE: "true", OPENCODE_CONFIG_CONTENT: JSON.stringify({
    permission, share: "disabled", autoupdate: false,
    agent: { "maze-maintainer": { mode: "primary", description: "Maintain the maze game", permission, steps: 25 } },
  }) },
  input: "This is a fresh maintenance task. First discover and load the relevant installed project skill with the native skill tool, and use its applicable project conventions. Then add WASD keyboard aliases to the maze without changing arrow keys or on-screen controls. Run appropriate tests and summarize what prior experience you reused. Do not write any skill files. Only use shell for node --test or node --check.",
});
await writeFile(path.join(artifacts, "reuse.jsonl"), output);
const result = parseRunOutput(output);
assert.notEqual(result.sessionId, previous.sessionId);
const events = output.split("\n").filter(line => line.trim()).map(line => JSON.parse(line));
const skillLoads = events.filter(event => event.type === "tool_use" && event.part?.tool === "skill"
  && event.part?.state?.status === "completed" && event.part?.state?.input?.name === "continual-learning");
assert.ok(skillLoads.length > 0, "Fresh session did not successfully load the published skill using the native skill tool");
const exported = await exportOpenCodeSession(result.sessionId, workspace, AbortSignal.timeout(30000));
await writeFile(path.join(artifacts, "reuse-export.json"), JSON.stringify(exported, null, 2));
const report = { sessionId: result.sessionId, sourceSessionId: previous.sessionId, skillLoads: skillLoads.length, toolCalls: result.toolCalls, text: result.text };
await writeFile(path.join(artifacts, "reuse-result.json"), JSON.stringify(report, null, 2));
console.log(JSON.stringify(report, null, 2));
