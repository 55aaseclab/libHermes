import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { command } from "../packages/adapters/opencode/process.js";
import { parseRunOutput } from "../packages/adapters/opencode/index.js";
import { exportOpenCodeSession } from "../packages/adapters/opencode/export.js";

const model = process.env.CL_OPENCODE_MODEL;
const root = process.env.CL_MAZE_ROOT;
if (!model || !root) throw new Error("Set CL_OPENCODE_MODEL and CL_MAZE_ROOT to an explicitly authorized test directory");
const workspace = path.resolve(root, "game");
const artifacts = path.resolve(root, "artifacts");
await mkdir(workspace, { recursive: true });
await mkdir(artifacts, { recursive: true });
const permissions = {
  "*": "deny", read: "allow", glob: "allow", grep: "allow", edit: "allow", write: "allow",
  bash: { "*": "deny", "node --test*": "allow", "node --check*": "allow" },
  skill: { "*": "deny", "continual-learning": "allow" }, external_directory: "deny",
};
const env = { ...process.env, OPENCODE_DISABLE_CLAUDE_CODE: "true", OPENCODE_CONFIG_CONTENT: JSON.stringify({
  share: "disabled", autoupdate: false, permission: permissions,
  agent: { "maze-worker": { mode: "primary", description: "Build a local maze game", permission: permissions, steps: 30 } },
}) };
const prompts = [
  "Build a tiny playable maze browser game in this directory. Use plain HTML/CSS/JavaScript with no dependencies or network assets. Use a fixed solvable maze, arrow-key movement, a visible start/exit and restart button. Separate pure game logic in game.mjs from DOM rendering in app.mjs, with index.html and styles.css. Add node:test tests in tests/game.test.mjs. Actually create files and run node --test tests/game.test.mjs. Keep it compact; do not use shell except node --test or node --check. Work only here. Do not create skills yet.",
  "Project correction to remember for future changes: wall collisions must NOT increment the move counter; reaching the exit must lock movement until restart; restart resets both moves and win state. First add focused regression tests, then fix the implementation, then run node --test tests/game.test.mjs. Keep the UI in sync. Do not create skills yet.",
  "Add on-screen direction buttons so the maze works without a keyboard. Project convention: keyboard and button actions must both go through one pure move function; do not duplicate collision/win logic in DOM handlers. Add tests for out-of-bounds moves and for following a complete path to the exit, run focused tests before the full node --test suite, and write a brief README explaining how to play and test. Do not create skills yet.",
];
let state: { sessionId?: string; completed: number } = { completed: 0 };
try { state = JSON.parse(await readFile(path.join(artifacts, "state.json"), "utf8")); } catch (error) {
  if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
}
for (let index = state.completed; index < prompts.length; index++) {
  const args = ["run", "--dir", workspace, "--pure", "--format", "json", "--model", model, "--agent", "maze-worker", "--title", "maze-learning-task"];
  if (state.sessionId) args.push("--session", state.sessionId);
  const output = await command("opencode", args, { cwd: workspace, env, input: prompts[index]!, signal: AbortSignal.timeout(240000), timeoutMs: 230000 });
  await writeFile(path.join(artifacts, `round-${index + 1}.jsonl`), output);
  const result = parseRunOutput(output);
  state = { sessionId: result.sessionId, completed: index + 1 };
  await writeFile(path.join(artifacts, "state.json"), JSON.stringify(state, null, 2));
  console.log(`Round ${index + 1}: ${result.toolCalls} tool events; session ${result.sessionId}\n${result.text.slice(-1000)}`);
}
const exported = await exportOpenCodeSession(state.sessionId!, workspace, AbortSignal.timeout(30000));
await writeFile(path.join(artifacts, "source-export.json"), JSON.stringify(exported, null, 2));
console.log("Artifacts:", artifacts);
