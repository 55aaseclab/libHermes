import { mkdtemp, realpath } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { FixtureHost, FakeReviewer } from "../packages/adapters/fixture.js";
import { LearningCore } from "../packages/core/core.js";
import { digest } from "../packages/protocol/validation.js";
import { ManagedSkillPublisher } from "../packages/publisher-skills/publisher.js";
import { LearningStore } from "../packages/storage-sqlite/store.js";
import { evidence, proposal, scope, taskEvent } from "./fixtures.js";

const directory = await mkdtemp(path.join(await realpath(os.tmpdir()), "continual-learning-demo-"));
const store = new LearningStore(path.join(directory, "learning.sqlite"));
try {
  const core = new LearningCore(store, [scope]);
  const signal = new AbortController().signal;
  const publisher = new ManagedSkillPublisher(path.join(directory, "managed-skills"), scope);
  const job = await core.capture(new FixtureHost(evidence()), taskEvent(), signal);
  const reviewed = await core.review(job!.id, new FakeReviewer(proposal()), signal);
  console.log("Before explicit demo approval:", store.list(scope).length, "items");
  store.approve(reviewed.id, { actor: "user", expectedProposalDigest: digest(reviewed.proposal) });
  await core.publish(scope, publisher);
  console.log("Published revision:", store.query(scope, "focused tests")[0]?.revision);

  const second = proposal();
  const firstOperation = second.operations[0]!;
  if (firstOperation.action !== "create") throw new Error("Unexpected fixture");
  second.operations = [{
    action: "revise", itemId: firstOperation.itemId, expectedRevision: 1,
    content: { ...firstOperation.content, body: "Run focused tests first, then run the full suite before release." },
  }];
  const next = await core.capture(new FixtureHost(evidence("2")), taskEvent("2"), signal);
  await core.review(next!.id, new FakeReviewer(second), signal);
  store.approve(next!.id, { actor: "user", expectedProposalDigest: digest(second) });
  store.revert({ commitKey: "demo-undo", scope, itemId: "focused-tests", expectedRevision: 2, targetRevision: 1 });
  await core.publish(scope, publisher);
  console.log("History after revert:", store.history(scope, "focused-tests").map(item => item.revision));
  console.log("Managed skill:", publisher.skillPath);
  console.log("Demo data retained in:", directory);
  console.log("Synthetic fixtures only; no model, host plugin, or user configuration was used.");
} finally {
  store.close();
}
