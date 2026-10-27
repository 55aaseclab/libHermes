import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, readdir, rename, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import plugin from "../plugins/opencode/continual-learning.mjs";

async function fixture(overrides = {}) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "cl-plugin-test-"));
  await mkdir(path.join(directory, ".continual-learning"));
  await writeFile(path.join(directory, ".continual-learning/config.json"), JSON.stringify({ enabled: true, allowNetwork: true, node: "/bin/true", model: "test/model", ...overrides }));
  const info = { id: "ses_test", title: "task" };
  const messages = [{ info: { id: "msg_test", role: "assistant", finish: "stop", time: { completed: 1 } }, parts: [] }];
  const hooks = await plugin({ directory, client: { session: { get: async () => ({ data: info }), messages: async () => ({ data: messages }) } } });
  const idle = () => hooks.event({ event: { type: "session.idle", properties: { sessionID: info.id } } });
  return { directory, info, messages, hooks, idle };
}

test("plugin is opt-in and requires network consent", async () => {
  assert.deepEqual((await fixture({ enabled: false })).hooks, {});
  assert.deepEqual((await fixture({ allowNetwork: false })).hooks, {});
});

test("idle captures a stable snapshot and coalesces concurrent events", async () => {
  const fixtureValue = await fixture();
  await Promise.all([fixtureValue.idle(), fixtureValue.idle()]);
  const queue = path.join(fixtureValue.directory, ".continual-learning/queue");
  const files = await readdir(queue);
  assert.equal(files.length, 1);
  const captured = JSON.parse(await readFile(path.join(queue, files[0]), "utf8"));
  assert.equal(captured.info.id, "ses_test");
  await fixtureValue.idle();
  assert.equal((await readdir(queue)).length, 1);
  await rename(path.join(queue, files[0]), path.join(queue, files[0] + ".done"));
  await fixtureValue.idle();
  assert.deepEqual(await readdir(queue), [files[0] + ".done"]);
});

test("review, child and unfinished sessions do not enqueue", async () => {
  for (const variant of ["review", "child", "unfinished", "error"]) {
    const value = await fixture();
    if (variant === "review") value.info.title = "continual-learning-review";
    if (variant === "child") value.info.parentID = "ses_parent";
    if (variant === "unfinished") value.messages[0].info.finish = "tool-calls";
    if (variant === "error") value.messages[0].info.error = { message: "failed" };
    await value.idle();
    assert.deepEqual(await readdir(path.join(value.directory, ".continual-learning/queue")), []);
  }
});

test("published experience is injected without user prompting", async () => {
  const value = await fixture();
  const output = { system: ["original"] };
  const hook = value.hooks["experimental.chat.system.transform"];
  await hook({ sessionID: "ses_fresh" }, output);
  assert.deepEqual(output.system, ["original"]);
  const skills = path.join(value.directory, ".opencode/skills/continual-learning");
  await mkdir(skills, { recursive: true });
  await writeFile(path.join(skills, "SKILL.md"), "Use wall bumps in player documentation");
  await hook({ sessionID: "ses_fresh" }, output);
  assert.match(output.system[1], /wall bumps/);
  assert.match(output.system[1], /current user instructions take precedence/);
});
