import { createHash } from "node:crypto";
import { Ajv, type ValidateFunction } from "ajv";
import type { EvidenceSnapshot, ProposalSet, Scope, TaskEvent } from "./types.js";

export class LearningError extends Error {
  constructor(public readonly code: string, message: string) {
    super(message);
    this.name = "LearningError";
  }
}

export function ensure(condition: unknown, code: string, message: string): asserts condition {
  if (!condition) throw new LearningError(code, message);
}

const identifier = { type: "string", pattern: "^[a-zA-Z0-9_-]{1,128}$" };
const text = { type: "string", minLength: 1, maxLength: 12000 };
const refs = { type: "array", items: identifier, minItems: 1, maxItems: 100, uniqueItems: true };
export const scopeSchema = {
  type: "object", additionalProperties: false, required: ["kind", "id"],
  properties: { kind: { enum: ["workspace", "user"] }, id: identifier },
};
const contentSchema = {
  type: "object", additionalProperties: false,
  required: ["kind", "title", "body", "applicability", "epistemicStatus", "evidenceRefs"],
  properties: {
    kind: { enum: ["preference", "procedure", "environment_fact", "pitfall"] },
    title: { type: "string", minLength: 1, maxLength: 200, pattern: "^[^\\r\\n]+$" },
    body: text,
    applicability: { type: "array", maxItems: 30, uniqueItems: true, items: { type: "string", minLength: 1, maxLength: 200 } },
    epistemicStatus: { enum: ["user_asserted", "observed", "inferred"] },
    evidenceRefs: refs,
  },
};
export const taskEventSchema = {
  type: "object", additionalProperties: false,
  required: ["protocolVersion", "eventId", "installationId", "sessionId", "taskId", "endCursor", "policyVersion", "scope", "origin", "completion"],
  properties: {
    protocolVersion: { const: "1.0" }, eventId: identifier, installationId: identifier,
    sessionId: identifier, taskId: identifier, endCursor: text, policyVersion: identifier,
    scope: scopeSchema,
    origin: { enum: ["task", "manual_review", "continual_learning_review"] },
    completion: { enum: ["completed", "failed", "interrupted", "unknown"] },
  },
};
export const snapshotSchema = {
  type: "object", additionalProperties: false,
  required: ["protocolVersion", "endCursor", "completeness", "events"],
  properties: {
    protocolVersion: { const: "1.0" }, endCursor: text,
    completeness: { enum: ["complete", "partial"] },
    events: {
      type: "array", minItems: 1, maxItems: 200,
      items: {
        type: "object", additionalProperties: false, required: ["id", "kind", "text"],
        properties: {
          id: identifier, text,
          kind: { enum: ["user_message", "assistant_message", "tool_call", "tool_result", "artifact_ref", "task_outcome"] },
        },
      },
    },
  },
};
export const proposalSchema = {
  type: "object", additionalProperties: false,
  required: ["protocolVersion", "scope", "operations", "rationale"],
  properties: {
    protocolVersion: { const: "1.0" }, scope: scopeSchema, rationale: text,
    operations: {
      type: "array", maxItems: 20,
      items: {
        oneOf: [
          {
            type: "object", additionalProperties: false, required: ["action", "itemId", "content"],
            properties: { action: { const: "create" }, itemId: identifier, content: contentSchema },
          },
          {
            type: "object", additionalProperties: false, required: ["action", "itemId", "expectedRevision", "content"],
            properties: {
              action: { const: "revise" }, itemId: identifier,
              expectedRevision: { type: "integer", minimum: 1 }, content: contentSchema,
            },
          },
          {
            type: "object", additionalProperties: false, required: ["action", "itemId", "expectedRevision", "evidenceRefs", "reason"],
            properties: {
              action: { const: "archive" }, itemId: identifier,
              expectedRevision: { type: "integer", minimum: 1 }, evidenceRefs: refs, reason: text,
            },
          },
        ],
      },
    },
  },
};

const ajv = new Ajv({ allErrors: true, strict: true });
const eventValidator = ajv.compile(taskEventSchema);
const snapshotValidator = ajv.compile(snapshotSchema);
const proposalValidator = ajv.compile(proposalSchema);
const scopeValidator = ajv.compile(scopeSchema);

function parse<T>(validator: ValidateFunction, input: unknown): T {
  const encoded = JSON.stringify(input);
  ensure(encoded && Buffer.byteLength(encoded) <= 2_000_000, "INVALID_INPUT", "Input exceeds size limit or is not JSON");
  const copy: unknown = JSON.parse(encoded);
  ensure(validator(copy), "INVALID_INPUT", ajv.errorsText(validator.errors));
  return copy as T;
}

export const parseEvent = (input: unknown): TaskEvent => parse(eventValidator, input);
export const parseScope = (input: unknown): Scope => parse(scopeValidator, input);
export const parseProposal = (input: unknown): ProposalSet => parse(proposalValidator, input);

export function parseSnapshot(input: unknown): EvidenceSnapshot {
  const snapshot = parse<EvidenceSnapshot>(snapshotValidator, input);
  ensure(new Set(snapshot.events.map(event => event.id)).size === snapshot.events.length, "INVALID_EVIDENCE", "Duplicate evidence IDs");
  return snapshot;
}

export const scopeKey = (scope: Scope): string => `${scope.kind}:${scope.id}`;

export function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value !== null && typeof value === "object") {
    const object = value as Record<string, unknown>;
    return `{${Object.keys(object).sort().map(key => `${JSON.stringify(key)}:${canonical(object[key])}`).join(",")}}`;
  }
  const result = JSON.stringify(value);
  ensure(result !== undefined, "INVALID_INPUT", "Value is not JSON");
  return result;
}

export const digest = (value: unknown): string => createHash("sha256").update(canonical(value)).digest("hex");
export const textDigest = (value: string): string => createHash("sha256").update(value).digest("hex");

export function checkProposal(proposal: ProposalSet, event: TaskEvent, snapshot: EvidenceSnapshot): void {
  ensure(scopeKey(proposal.scope) === scopeKey(event.scope), "SCOPE_MISMATCH", "A review cannot change scope");
  const touched = new Set<string>();
  const evidence = new Map(snapshot.events.map(entry => [entry.id, entry]));
  for (const operation of proposal.operations) {
    ensure(!touched.has(operation.itemId), "DUPLICATE_OPERATION", "An item may only change once in a proposal");
    touched.add(operation.itemId);
    const references = operation.action === "archive" ? operation.evidenceRefs : operation.content.evidenceRefs;
    ensure(references.every(reference => evidence.has(reference)), "INVALID_EVIDENCE", "Unknown evidence reference");
    if (operation.action !== "archive") {
      const status = operation.content.epistemicStatus;
      if (status === "user_asserted") {
        ensure(references.some(reference => evidence.get(reference)?.kind === "user_message"), "INVALID_EVIDENCE", "User assertion requires user evidence");
      }
      if (status === "observed") {
        ensure(references.some(reference => ["tool_result", "artifact_ref", "task_outcome"].includes(evidence.get(reference)!.kind)), "INVALID_EVIDENCE", "Observation requires execution or artifact evidence");
      }
    }
  }
}
