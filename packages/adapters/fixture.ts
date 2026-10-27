import type { EvidenceSnapshot, HostAdapter, ReviewEvent, ReviewRequest, ReviewerAdapter, TaskEvent } from "../protocol/types.js";
import { parseEvent, parseSnapshot } from "../protocol/validation.js";

export class FixtureHost implements HostAdapter {
  private readonly snapshot: EvidenceSnapshot;

  constructor(snapshot: unknown) {
    this.snapshot = parseSnapshot(snapshot);
  }

  async probe() {
    return { id: "fixture", surface: "fixture" as const, automaticEvents: false as const };
  }

  async normalizeEvent(input: unknown): Promise<TaskEvent> {
    return parseEvent(input);
  }

  async capture(_event: TaskEvent, signal: AbortSignal): Promise<EvidenceSnapshot> {
    signal.throwIfAborted();
    return structuredClone(this.snapshot);
  }
}

export class FakeReviewer implements ReviewerAdapter {
  constructor(private readonly response: unknown) {}

  async probe() {
    return { id: "fake", network: false as const, storageWrite: false as const };
  }

  async *review(_request: ReviewRequest, signal: AbortSignal): AsyncIterable<ReviewEvent> {
    signal.throwIfAborted();
    yield { type: "proposal", proposal: structuredClone(this.response) };
    yield { type: "completed" };
  }
}
