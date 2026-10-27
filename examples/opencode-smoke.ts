import assert from "node:assert/strict";
import { mkdtemp, readFile, realpath, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { OpenCodeExportHost, OpenCodeReviewer, parseRunOutput, runRestrictedOpenCode } from "../packages/adapters/opencode/index.js";
import { exportOpenCodeSession } from "../packages/adapters/opencode/export.js";
import { LearningCore } from "../packages/core/core.js";
import { digest } from "../packages/protocol/validation.js";
import { ManagedSkillPublisher } from "../packages/publisher-skills/publisher.js";
import { LearningStore } from "../packages/storage-sqlite/store.js";

const model = process.env.CL_OPENCODE_MODEL;
assert.ok(model, "Set CL_OPENCODE_MODEL to explicitly select a provider/model. This smoke test sends synthetic data to that provider.");
const directory = await mkdtemp(path.join(await realpath(os.tmpdir()), "cl-opencode-smoke-"));
const scope = { kind: "workspace" as const, id: "synthetic-opencode-project" };
const signal = AbortSignal.timeout(240000);
const store = new LearningStore(path.join(directory, "learning.sqlite"));
try {
  const source = parseRunOutput(await runRestrictedOpenCode(
    "Synthetic test task. Project correction: for this project, always run focused unit tests before the full test suite. Do not run tests or tools now; just acknowledge this preference in one sentence.",
    model, signal, 90000, "synthetic-task-for-continual-learning",
  ));
  const exported = await exportOpenCodeSession(source.sessionId, directory, signal);
  await writeFile(path.join(directory, "source-export.json"), JSON.stringify(exported, null, 2));
  const host = new OpenCodeExportHost(exported, scope, "opencode-smoke-local", "synthetic-task-1");
  const core = new LearningCore(store, [scope]);
  const job = await core.capture(host, host.event, signal);
  assert.ok(job);
  const reviewer = new OpenCodeReviewer(model);
  const reviewed = await core.review(job.id, reviewer, signal, { allowNetwork: true });
  assert.equal(reviewed.status, "proposed", "Expected the explicit synthetic user correction to produce a proposal");
  assert.equal(store.list(scope).length, 0, "Review must not write active items before approval");
  assert.ok(reviewed.proposal);
  assert.ok(reviewed.proposal.operations.some(operation => operation.action !== "archive" && operation.content.epistemicStatus === "user_asserted"));
  await writeFile(path.join(directory, "proposal.json"), JSON.stringify(reviewed.proposal, null, 2));
  const receipt = store.approve(job.id, { actor: "user", expectedProposalDigest: digest(reviewed.proposal) });
  const publisher = new ManagedSkillPublisher(path.join(directory, ".opencode", "skills"), scope);
  await core.publish(scope, publisher);
  assert.match(await readFile(publisher.skillPath, "utf8"), /focused|unit/i);
  assert.equal(reviewer.lastRun?.toolCalls, 0);
  const result = { model, sourceSessionId: source.sessionId, review: reviewer.lastRun, receipt,
    directory, skillPath: publisher.skillPath, checks: ["real source session", "explicit export", "real reviewer", "no reviewer tools", "approval required", "published skill"] };
  await writeFile(path.join(directory, "result.json"), JSON.stringify(result, null, 2));
  console.log(JSON.stringify(result, null, 2));
} finally { store.close(); }
