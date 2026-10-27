import { readFile } from "node:fs/promises";
import path from "node:path";
import { OpenCodeExportHost, OpenCodeReviewer } from "../adapters/opencode/index.js";
import { LearningCore } from "../core/core.js";
import { digest, ensure } from "../protocol/validation.js";
import { LearningStore } from "../storage-sqlite/store.js";

const [exportPath, databasePath, workspaceId, model, permission] = process.argv.slice(2);
ensure(exportPath && databasePath && workspaceId && model && permission === "--allow-network", "USAGE",
  "Usage: node dist/packages/cli/opencode-review.js <export.json> <database.sqlite> <workspace-id> <provider/model> --allow-network. Sends the selected export to that model; does not approve or publish.");
const raw = await readFile(path.resolve(exportPath), "utf8");
ensure(Buffer.byteLength(raw) <= 2_000_000, "INPUT_LIMIT", "Export is too large; explicitly select a smaller task export");
const scope = { kind: "workspace" as const, id: workspaceId };
const host = new OpenCodeExportHost(JSON.parse(raw), scope, "opencode-manual-local", "explicit-export", OpenCodeReviewer.policyVersion);
const store = new LearningStore(path.resolve(databasePath));
try {
  const core = new LearningCore(store, [scope]);
  const signal = AbortSignal.timeout(120000);
  const job = await core.capture(host, host.event, signal);
  ensure(job, "NO_TASK", "No eligible task");
  const reviewed = job.status === "queued"
    ? await core.review(job.id, new OpenCodeReviewer(model), signal, { allowNetwork: true })
    : job;
  console.log(JSON.stringify({ jobId: reviewed.id, status: reviewed.status,
    proposalDigest: reviewed.proposal ? digest(reviewed.proposal) : null, proposal: reviewed.proposal,
    approved: reviewed.status === "committed" }, null, 2));
} finally { store.close(); }
