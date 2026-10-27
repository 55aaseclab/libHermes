export type Scope = { kind: "workspace" | "user"; id: string };

export interface TaskEvent {
  protocolVersion: "1.0";
  eventId: string;
  installationId: string;
  sessionId: string;
  taskId: string;
  endCursor: string;
  policyVersion: string;
  scope: Scope;
  origin: "task" | "manual_review" | "continual_learning_review";
  completion: "completed" | "failed" | "interrupted" | "unknown";
}

export interface Evidence {
  id: string;
  kind: "user_message" | "assistant_message" | "tool_call" | "tool_result" | "artifact_ref" | "task_outcome";
  text: string;
}

export interface EvidenceSnapshot {
  protocolVersion: "1.0";
  endCursor: string;
  completeness: "complete" | "partial";
  events: Evidence[];
}

export interface ItemContent {
  kind: "preference" | "procedure" | "environment_fact" | "pitfall";
  title: string;
  body: string;
  applicability: string[];
  epistemicStatus: "user_asserted" | "observed" | "inferred";
  evidenceRefs: string[];
}

export type Operation =
  | { action: "create"; itemId: string; content: ItemContent }
  | { action: "revise"; itemId: string; expectedRevision: number; content: ItemContent }
  | { action: "archive"; itemId: string; expectedRevision: number; evidenceRefs: string[]; reason: string };

export interface ProposalSet {
  protocolVersion: "1.0";
  scope: Scope;
  operations: Operation[];
  rationale: string;
}

export interface LearningItem extends ItemContent {
  id: string;
  revision: number;
  scope: Scope;
  lifecycle: "active" | "archived";
  origin: { type: "review" | "revert"; id: string };
  evidenceSourceJobId: string;
}

export type JobStatus = "queued" | "proposed" | "no_change" | "committed" | "cancelled";

export interface Job {
  id: string;
  event: TaskEvent;
  snapshot: EvidenceSnapshot;
  snapshotDigest: string;
  status: JobStatus;
  proposal: ProposalSet | null;
  receipt: CommitReceipt | null;
}

export interface CommitReceipt {
  commitId: string;
  generation: number;
  revisions: Array<{ itemId: string; revision: number }>;
}

export interface Publication {
  scope: Scope;
  generation: number;
  items: LearningItem[];
}

export interface HostAdapter {
  probe(): Promise<{ id: string; surface: "fixture" | "cli"; automaticEvents: false }>;
  normalizeEvent(input: unknown): Promise<TaskEvent | null>;
  capture(event: TaskEvent, signal: AbortSignal): Promise<EvidenceSnapshot>;
}

export interface ReviewRequest {
  jobId: string;
  origin: "continual_learning_review";
  event: TaskEvent;
  snapshot: EvidenceSnapshot;
  existingItems: LearningItem[];
}

export type ReviewEvent =
  | { type: "proposal"; proposal: unknown }
  | { type: "completed" };

export interface ReviewerAdapter {
  probe(): Promise<{ id: string; network: boolean; storageWrite: false }>;
  review(request: ReviewRequest, signal: AbortSignal): AsyncIterable<ReviewEvent>;
}

export interface SkillPublisher {
  publish(publication: Publication): Promise<void>;
}
