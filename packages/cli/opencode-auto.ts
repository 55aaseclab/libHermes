import { appendFile, readdir, readFile, rename } from "node:fs/promises";
import path from "node:path";
import { OpenCodeExportHost, OpenCodeReviewer } from "../adapters/opencode/index.js";
import { LearningCore } from "../core/core.js";
import { digest, ensure } from "../protocol/validation.js";
import { LearningStore } from "../storage-sqlite/store.js";
import { ManagedSkillPublisher } from "../publisher-skills/publisher.js";

const workspace = path.resolve(process.argv[2]!);
const root = path.join(workspace, ".continual-learning");
const config = JSON.parse(await readFile(path.join(root, "config.json"), "utf8"));
ensure(config.enabled === true && config.allowNetwork === true, "CONFIG", "Automatic network review must be explicitly enabled");
const scope = { kind: "workspace" as const, id: `workspace-${digest(workspace).slice(0, 32)}` };
const store = new LearningStore(path.join(root, "learning.sqlite"));
const core = new LearningCore(store, [scope]);
const publisher = new ManagedSkillPublisher(path.join(workspace, ".opencode", "skills"), scope);
const log = async (entry: object) => appendFile(path.join(root, "events.jsonl"), JSON.stringify({ time: new Date().toISOString(), ...entry }) + "\n");
try {
  await core.publish(scope, publisher);
  for (const filename of (await readdir(path.join(root, "queue"))).filter(name => name.endsWith(".json")).sort()) {
    const source = path.join(root, "queue", filename);
    try {
      const raw = await readFile(source, "utf8");
      ensure(Buffer.byteLength(raw) <= 2_000_000, "INPUT_LIMIT", "Snapshot exceeds limit");
      const exported = JSON.parse(raw);
      const host = new OpenCodeExportHost(exported, scope, "opencode-auto", "session-idle", OpenCodeReviewer.policyVersion);
      host.event.origin = "task";
      const signal = AbortSignal.timeout(190000);
      let job = await core.capture(host, host.event, signal);
      ensure(job, "NO_TASK", "No task captured");
      await log({ type: "captured", sessionId: host.event.sessionId, jobId: job.id });
      if (job.status === "queued") job = await core.review(job.id, new OpenCodeReviewer(config.model, 180000), signal, { allowNetwork: true });
      if (job.status === "proposed" && config.autoApprove === true) {
        store.approve(job.id, { actor: "policy", scope, policyId: "opencode-workspace-auto-v1", expectedProposalDigest: digest(job.proposal) });
        job = store.getJob(job.id);
      }
      await core.publish(scope, publisher);
      await log({ type: "reviewed", sessionId: host.event.sessionId, jobId: job.id, status: job.status });
      await rename(source, source + ".done");
    } catch (error) {
      await log({ type: "error", file: filename, code: (error as { code?: string }).code ?? "REVIEW_FAILED" });
      await rename(source, source + ".failed");
    }
  }
} finally { store.close(); }
