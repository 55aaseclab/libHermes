import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import { FixtureHost, FakeReviewer } from "../packages/adapters/fixture.js";
import { LearningCore } from "../packages/core/core.js";
import { digest, LearningError } from "../packages/protocol/validation.js";
import { ManagedSkillPublisher } from "../packages/publisher-skills/publisher.js";
import { LearningStore } from "../packages/storage-sqlite/store.js";
import { evidence, proposal, scope, taskEvent } from "../examples/fixtures.js";

async function setup() {
  const directory = await mkdtemp(path.join(os.tmpdir(), "continual-learning-test-"));
  const store = new LearningStore(path.join(directory, "learning.sqlite"));
  return { directory, store, core: new LearningCore(store, [scope]) };
}

test("replays the same host event idempotently", async () => {
  const { store, core } = await setup();
  try {
    const host = new FixtureHost(evidence());
    const event = taskEvent();
    const first = await core.capture(host, event, new AbortController().signal);
    const second = await core.capture(host, event, new AbortController().signal);
    assert.equal(first?.id, second?.id);
    assert.equal(store.list(scope).length, 0);
  } finally { store.close(); }
});

test("ignores review-origin events and rejects unauthorized scopes", async () => {
  const { store, core } = await setup();
  try {
    const signal = new AbortController().signal;
    assert.equal(await core.capture(new FixtureHost(evidence()), { ...taskEvent(), origin: "continual_learning_review" }, signal), null);
    await assert.rejects(() => core.capture(new FixtureHost(evidence()), { ...taskEvent(), scope: { kind: "user", id: "other" } }, signal),
      (error: unknown) => error instanceof LearningError && error.code === "SCOPE_DENIED");
  } finally { store.close(); }
});

test("cancelled jobs reject late reviewer results", async () => {
  const { store } = await setup();
  try {
    const job = store.ingest(taskEvent(), evidence())!;
    store.cancel(job.id);
    assert.throws(() => store.saveProposal(job.id, proposal()),
      (error: unknown) => error instanceof LearningError && error.code === "JOB_STATE");
    assert.equal(store.list(scope).length, 0);
  } finally { store.close(); }
});

test("approval retry is idempotent and pending publication survives reopening", async () => {
  const { directory, store } = await setup();
  const job = store.ingest(taskEvent(), evidence())!;
  store.saveProposal(job.id, proposal());
  const approval = { actor: "user" as const, expectedProposalDigest: digest(proposal()) };
  const receipt = store.approve(job.id, approval);
  assert.deepEqual(store.approve(job.id, approval), receipt);
  store.close();
  const reopened = new LearningStore(path.join(directory, "learning.sqlite"));
  try {
    assert.equal(reopened.preparePublication(scope)?.generation, receipt.generation);
    assert.equal(reopened.history(scope, "focused-tests").length, 1);
  } finally { reopened.close(); }
});

test("a conflicting operation rolls back the entire proposal", async () => {
  const { store } = await setup();
  try {
    const first = store.ingest(taskEvent(), evidence())!;
    store.saveProposal(first.id, proposal());
    store.approve(first.id, { actor: "user", expectedProposalDigest: digest(proposal()) });
    const conflicting = proposal();
    const original = conflicting.operations[0]!;
    conflicting.operations = [{ ...original, itemId: "new-item" }, original];
    const second = store.ingest(taskEvent("2"), evidence("2"))!;
    store.saveProposal(second.id, conflicting);
    assert.throws(() => store.approve(second.id, { actor: "user", expectedProposalDigest: digest(conflicting) }),
      (error: unknown) => error instanceof LearningError && error.code === "REVISION_CONFLICT");
    assert.equal(store.getItem(scope, "new-item"), null);
    assert.equal(store.getJob(second.id).status, "proposed");
  } finally { store.close(); }
});

test("requires evidence for an inferred and observed proposal", async () => {
  const { store, core } = await setup();
  try {
    const job = await core.capture(new FixtureHost(evidence()), taskEvent(), new AbortController().signal);
    const invalid = proposal();
    const operation = invalid.operations[0]!;
    if (operation.action !== "create") throw new Error("fixture shape");
    operation.content = { ...operation.content, epistemicStatus: "observed", evidenceRefs: ["user-correction"] };
    await assert.rejects(
      () => core.review(job!.id, new FakeReviewer(invalid), new AbortController().signal),
      (error: unknown) => error instanceof LearningError && error.code === "INVALID_EVIDENCE",
    );
  } finally { store.close(); }
});

test("approval, publication, CAS conflict, revert and projection drift work", async () => {
  const { directory, store, core } = await setup();
  try {
    const signal = new AbortController().signal;
    const publisher = new ManagedSkillPublisher(path.join(directory, "skills"), scope);
    const job = await core.capture(new FixtureHost(evidence()), taskEvent(), signal);
    const reviewed = await core.review(job!.id, new FakeReviewer(proposal()), signal);
    store.approve(reviewed.id, { actor: "user", expectedProposalDigest: digest(reviewed.proposal) });
    await core.publish(scope, publisher);
    assert.match(await readFile(publisher.skillPath, "utf8"), /focused tests/i);

    const changed = proposal();
    const create = changed.operations[0]!;
    if (create.action !== "create") throw new Error("fixture shape");
    changed.operations = [{ action: "revise", itemId: create.itemId, expectedRevision: 1, content: { ...create.content, body: "A second revision." } }];
    const next = await core.capture(new FixtureHost(evidence("2")), taskEvent("2"), signal);
    const nextReviewed = await core.review(next!.id, new FakeReviewer(changed), signal);
    store.approve(nextReviewed.id, { actor: "user", expectedProposalDigest: digest(nextReviewed.proposal) });
    assert.throws(
      () => store.revert({ commitKey: "stale", scope, itemId: create.itemId, expectedRevision: 1, targetRevision: 1 }),
      (error: unknown) => error instanceof LearningError && error.code === "REVISION_CONFLICT",
    );
    store.revert({ commitKey: "undo", scope, itemId: create.itemId, expectedRevision: 2, targetRevision: 1 });
    assert.deepEqual(store.history(scope, create.itemId).map(item => item.revision), [1, 2, 3]);
    await core.publish(scope, publisher);
    await writeFile(publisher.skillPath, `${await readFile(publisher.skillPath, "utf8")}manual edit\n`);
    await assert.rejects(() => publisher.plan({ scope, generation: 4, items: store.list(scope) }), (error: unknown) => error instanceof LearningError && error.code === "PROJECTION_DRIFT");
  } finally { store.close(); }
});
