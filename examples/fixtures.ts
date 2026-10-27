import type { EvidenceSnapshot, ProposalSet, Scope, TaskEvent } from "../packages/protocol/types.js";

export const scope: Scope = { kind: "workspace", id: "example-project" };

export function taskEvent(suffix = "1"): TaskEvent {
  return {
    protocolVersion: "1.0", eventId: `event-${suffix}`, installationId: "fixture-local",
    sessionId: "session-1", taskId: `task-${suffix}`, endCursor: `cursor-${suffix}`,
    policyVersion: "policy-v1", scope, origin: "task", completion: "completed",
  };
}

export function evidence(suffix = "1"): EvidenceSnapshot {
  return {
    protocolVersion: "1.0", endCursor: `cursor-${suffix}`, completeness: "complete",
    events: [
      { id: "user-correction", kind: "user_message", text: "For this project, run the focused tests before running the entire suite." },
      { id: "test-result", kind: "tool_result", text: "Focused tests: exit code 0. This is a synthetic fixture, not a real execution." },
    ],
  };
}

export function proposal(): ProposalSet {
  return {
    protocolVersion: "1.0", scope, rationale: "Record an explicit project-scoped user preference from a synthetic fixture.",
    operations: [{
      action: "create", itemId: "focused-tests",
      content: {
        kind: "procedure", title: "Run focused tests first", body: "Run the focused tests for the changed component before the full suite.",
        applicability: ["this project", "when changing code"], epistemicStatus: "user_asserted",
        evidenceRefs: ["user-correction"],
      },
    }],
  };
}
