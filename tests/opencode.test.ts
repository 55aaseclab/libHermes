import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { OpenCodeExportHost, OpenCodeReviewer, parseRunOutput } from "../packages/adapters/opencode/index.js";
import { command } from "../packages/adapters/opencode/process.js";
import { LearningCore } from "../packages/core/core.js";
import { LearningError } from "../packages/protocol/validation.js";
import { LearningStore } from "../packages/storage-sqlite/store.js";
import { evidence, proposal, scope, taskEvent } from "../examples/fixtures.js";
import { digest } from "../packages/protocol/validation.js";

test("automatic approval is scope-bound and remains idempotent", () => {
  const store = new LearningStore(":memory:");
  try {
    const job = store.ingest(taskEvent(), evidence());
    assert.ok(job);
    store.saveProposal(job.id, proposal());
    const approval = { actor: "policy" as const, policyId: "test-policy", scope, expectedProposalDigest: digest(proposal()) };
    assert.throws(() => store.approve(job.id, { ...approval, scope: { kind: "workspace", id: "other" } }), /scope mismatch/);
    const receipt = store.approve(job.id, approval);
    assert.deepEqual(store.approve(job.id, approval), receipt);
    assert.equal(store.getJob(job.id).status, "committed");
  } finally { store.close(); }
});

function exported() {
  return { info: { id: "ses_example", title: "task" }, messages: [
    { info: { id: "msg_user", sessionID: "ses_example", role: "user" }, parts: [{ id: "part_user", type: "text", text: "Use focused tests first." }] },
    { info: { id: "msg_assistant", sessionID: "ses_example", role: "assistant" }, parts: [{ id: "part_assistant", type: "text", text: "Tests passed." }] },
  ] };
}

test("OpenCode export preserves user evidence and does not promote assistant claims", async () => {
  const host = new OpenCodeExportHost(exported(), scope, "local", "task");
  const snapshot = await host.capture(host.event, new AbortController().signal);
  assert.deepEqual(snapshot.events.map(event => event.kind), ["user_message", "assistant_message"]);
  assert.equal(host.event.completion, "unknown");
  assert.equal(host.event.origin, "manual_review");
  const second = new OpenCodeExportHost(exported(), scope, "local", "task");
  assert.equal(host.event.endCursor, second.event.endCursor);
});

test("OpenCode export rejects mixed sessions and review reingestion", () => {
  const input = exported();
  input.info.title = "continual-learning-review";
  assert.throws(() => new OpenCodeExportHost(input, scope, "local", "task"), /Review sessions/);
  input.info.title = "task";
  input.messages[0]!.info.sessionID = "ses_other";
  assert.throws(() => new OpenCodeExportHost(input, scope, "local", "task"), /different session/);
});

test("OpenCode export event identities include scope and review policy", () => {
  const first = new OpenCodeExportHost(exported(), scope, "local", "task", "review-v1");
  const nextPolicy = new OpenCodeExportHost(exported(), scope, "local", "task", "review-v2");
  const nextScope = new OpenCodeExportHost(exported(), { kind: "workspace", id: "other" }, "local", "task", "review-v1");
  assert.notEqual(first.event.eventId, nextPolicy.event.eventId);
  assert.notEqual(first.event.eventId, nextScope.event.eventId);
  assert.equal(first.event.endCursor, nextPolicy.event.endCursor);
});

test("OpenCode stream requires completed output and exposes tool calls", () => {
  const rows = [
    { type: "text", sessionID: "ses_test", part: { text: "{}" } },
    { type: "tool_use", sessionID: "ses_test", part: {} },
    { type: "step_finish", sessionID: "ses_test", part: { reason: "stop" } },
  ];
  const result = parseRunOutput(rows.map(row => JSON.stringify(row)).join("\n"));
  assert.equal(result.toolCalls, 1);
  assert.throws(() => parseRunOutput(JSON.stringify(rows[0])), /completed assistant/);
});

test("network reviewer requires explicit data export permission before launching", async () => {
  const store = new LearningStore(":memory:");
  try {
    const job = store.ingest(taskEvent(), evidence())!;
    const core = new LearningCore(store, [scope]);
    await assert.rejects(() => core.review(job.id, new OpenCodeReviewer("never/call"), new AbortController().signal),
      (error: unknown) => error instanceof LearningError && error.code === "REVIEWER_DENIED");
  } finally { store.close(); }
});

test("process runner enforces timeout and accepts stdin without a shell", async () => {
  const cwd = await mkdtemp(path.join(os.tmpdir(), "cl-process-test-"));
  const signal = new AbortController().signal;
  assert.equal(await command(process.execPath, ["-e", "process.stdin.pipe(process.stdout)"], { cwd, signal, timeoutMs: 3000, input: "$(not-a-command)" }), "$(not-a-command)");
  assert.equal(await command(process.execPath, ["-e", "process.stdout.write(process.cwd()+'\\n'+process.env.PWD)"], { cwd, signal, timeoutMs: 3000 }), `${cwd}\n${cwd}`);
  await assert.rejects(() => command(process.execPath, ["-e", "setTimeout(()=>{},10000)"], { cwd, signal, timeoutMs: 100 }),
    (error: unknown) => error instanceof LearningError && error.code === "TIMEOUT");
});
