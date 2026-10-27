import type { HostAdapter, Job, ReviewerAdapter, Scope, SkillPublisher } from "../protocol/types.js";
import { ensure, parseEvent, scopeKey } from "../protocol/validation.js";
import { LearningStore } from "../storage-sqlite/store.js";

export class LearningCore {
  private readonly allowedScopes: Set<string>;

  constructor(private readonly store: LearningStore, scopes: Scope[]) {
    this.allowedScopes = new Set(scopes.map(scopeKey));
  }

  private authorize(scope: Scope): void {
    ensure(this.allowedScopes.has(scopeKey(scope)), "SCOPE_DENIED", "Scope has not been authorized for this core instance");
  }

  async capture(host: HostAdapter, nativeEvent: unknown, signal: AbortSignal): Promise<Job | null> {
    signal.throwIfAborted();
    const candidate = await host.normalizeEvent(nativeEvent);
    if (!candidate) return null;
    const event = parseEvent(candidate);
    if (event.origin === "continual_learning_review") return null;
    this.authorize(event.scope);
    const snapshot = await host.capture(event, signal);
    signal.throwIfAborted();
    return this.store.ingest(event, snapshot);
  }

  async review(jobId: string, reviewer: ReviewerAdapter, signal: AbortSignal, options: { allowNetwork?: boolean } = {}): Promise<Job> {
    signal.throwIfAborted();
    const job = this.store.getJob(jobId);
    this.authorize(job.event.scope);
    ensure(job.status === "queued", "JOB_STATE", "Job is not queued");
    const capabilities = await reviewer.probe();
    ensure((!capabilities.network || options.allowNetwork === true) && capabilities.storageWrite === false, "REVIEWER_DENIED", "Network review requires explicit data-export permission; store writes are forbidden");
    let proposal: unknown;
    let receivedProposal = false;
    let completed = false;
    let count = 0;
    for await (const event of reviewer.review({
      jobId, origin: "continual_learning_review", event: job.event, snapshot: job.snapshot,
      existingItems: this.store.list(job.event.scope),
    }, signal)) {
      signal.throwIfAborted();
      ensure(!completed && ++count <= 100, "REVIEW_PROTOCOL", "Invalid reviewer event sequence");
      if (event.type === "proposal") {
        ensure(!receivedProposal, "REVIEW_PROTOCOL", "Reviewer emitted multiple proposals");
        proposal = event.proposal;
        receivedProposal = true;
      } else {
        ensure(event.type === "completed" && receivedProposal, "REVIEW_PROTOCOL", "Completion requires a proposal");
        completed = true;
      }
    }
    signal.throwIfAborted();
    ensure(completed, "REVIEW_PROTOCOL", "Reviewer stream ended without completion");
    return this.store.saveProposal(jobId, proposal);
  }

  async publish(scope: Scope, publisher: SkillPublisher): Promise<boolean> {
    this.authorize(scope);
    const publication = this.store.preparePublication(scope);
    if (!publication) return false;
    await publisher.publish(publication);
    this.store.acknowledgePublication(publication);
    return true;
  }
}
