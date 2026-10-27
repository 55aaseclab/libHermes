import path from "node:path";
import { ensure } from "../protocol/validation.js";
import { LearningCore } from "../core/core.js";
import { ManagedSkillPublisher } from "../publisher-skills/publisher.js";
import { LearningStore } from "../storage-sqlite/store.js";

const [databasePath, jobId, proposalDigest, skillsRoot, confirmation] = process.argv.slice(2);
ensure(databasePath && jobId && proposalDigest && skillsRoot && confirmation === "--approve", "USAGE",
  "Usage: node dist/packages/cli/approve.js <database.sqlite> <job-id> <proposal-digest> <managed-skills-root> --approve. Inspect the proposal before running.");
const store = new LearningStore(path.resolve(databasePath));
try {
  const job = store.getJob(jobId);
  const receipt = store.approve(jobId, { actor: "user", expectedProposalDigest: proposalDigest });
  const core = new LearningCore(store, [job.event.scope]);
  const publisher = new ManagedSkillPublisher(skillsRoot, job.event.scope);
  await core.publish(job.event.scope, publisher);
  console.log(JSON.stringify({ receipt, skillPath: publisher.skillPath }, null, 2));
} finally { store.close(); }
