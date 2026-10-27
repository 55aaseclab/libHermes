import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { ensure } from "../protocol/validation.js";

const [workspaceArg, model, ...flags] = process.argv.slice(2);
ensure(workspaceArg && model?.includes("/") && flags.includes("--allow-network"), "USAGE", "Usage: node dist/packages/cli/opencode-install.js <workspace> <provider/model> --allow-network [--auto-approve]. Installs automatic task review and context injection. Auto-approve authorizes workspace-scoped commits without individual confirmation.");
const workspace = path.resolve(workspaceArg);
const root = path.join(workspace, ".continual-learning");
await mkdir(root, { recursive: true, mode: 0o700 });
await mkdir(path.join(workspace, ".opencode/plugins"), { recursive: true });
const plugin = fileURLToPath(new URL("../../../plugins/opencode/continual-learning.mjs", import.meta.url));
await writeFile(path.join(root, "config.json"), JSON.stringify({ enabled: true, allowNetwork: true, autoApprove: flags.includes("--auto-approve"), node: process.execPath, model }, null, 2), { flag: "wx", mode: 0o600 });
await writeFile(path.join(workspace, ".opencode/plugins/continual-learning.mjs"), `export { default } from ${JSON.stringify(plugin)};\n`, { flag: "wx", mode: 0o600 });
console.log(`Installed automatic learning for ${workspace}. Restart OpenCode without --pure. Audit: ${root}/events.jsonl`);
