import { randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import type { CommitReceipt, EvidenceSnapshot, Job, LearningItem, ProposalSet, Publication, Scope, TaskEvent } from "../protocol/types.js";
import { canonical, checkProposal, digest, ensure, parseEvent, parseProposal, parseScope, parseSnapshot, scopeKey } from "../protocol/validation.js";

type Row = Record<string, unknown>;
const decode = <T>(value: unknown): T => JSON.parse(String(value)) as T;

export class LearningStore {
  private readonly database: DatabaseSync;

  constructor(path: string) {
    this.database = new DatabaseSync(path);
    try {
      this.database.exec("PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 3000;");
      const version = Number(this.database.prepare("PRAGMA user_version").get()!.user_version);
      ensure(version === 0 || version === 1, "SCHEMA_VERSION", `Unsupported database version ${version}`);
      this.database.exec("PRAGMA journal_mode = WAL;");
      this.transaction(() => {
        this.database.exec(`
          CREATE TABLE IF NOT EXISTS jobs (
            id TEXT PRIMARY KEY, dedupe_key TEXT UNIQUE NOT NULL, payload_digest TEXT NOT NULL,
            event_json TEXT NOT NULL, snapshot_json TEXT NOT NULL, snapshot_digest TEXT NOT NULL,
            status TEXT NOT NULL, proposal_json TEXT, receipt_json TEXT
          );
          CREATE TABLE IF NOT EXISTS events (
            event_key TEXT PRIMARY KEY, payload_digest TEXT NOT NULL,
            job_id TEXT NOT NULL REFERENCES jobs(id)
          );
          CREATE TABLE IF NOT EXISTS items (
            scope TEXT NOT NULL, id TEXT NOT NULL, revision INTEGER NOT NULL,
            item_json TEXT NOT NULL, PRIMARY KEY(scope, id)
          );
          CREATE TABLE IF NOT EXISTS revisions (
            scope TEXT NOT NULL, id TEXT NOT NULL, revision INTEGER NOT NULL,
            item_json TEXT NOT NULL, PRIMARY KEY(scope, id, revision)
          );
          CREATE TABLE IF NOT EXISTS commits (
            id TEXT PRIMARY KEY, request_digest TEXT NOT NULL, receipt_json TEXT NOT NULL
          );
          CREATE TABLE IF NOT EXISTS outbox (
            generation INTEGER PRIMARY KEY AUTOINCREMENT, scope TEXT NOT NULL,
            status TEXT NOT NULL DEFAULT 'pending'
          );
          CREATE TABLE IF NOT EXISTS audit (
            sequence INTEGER PRIMARY KEY AUTOINCREMENT, action TEXT NOT NULL,
            reference TEXT NOT NULL, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
          );
          CREATE VIRTUAL TABLE IF NOT EXISTS items_search USING fts5(scope UNINDEXED, id UNINDEXED, title, body);
          PRAGMA user_version = 1;
        `);
      });
    } catch (error) {
      this.database.close();
      throw error;
    }
  }

  close(): void {
    this.database.close();
  }

  private transaction<T>(operation: () => T): T {
    this.database.exec("BEGIN IMMEDIATE");
    try {
      const result = operation();
      this.database.exec("COMMIT");
      return result;
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    }
  }

  private audit(action: string, reference: string): void {
    this.database.prepare("INSERT INTO audit(action, reference) VALUES (?, ?)").run(action, reference);
  }

  ingest(eventInput: unknown, snapshotInput: unknown): Job | null {
    const event = parseEvent(eventInput);
    if (event.origin === "continual_learning_review") return null;
    const snapshot = parseSnapshot(snapshotInput);
    ensure(snapshot.endCursor === event.endCursor, "CURSOR_MISMATCH", "Snapshot cursor must match task boundary");
    const { eventId: ignoredEventId, ...identity } = event;
    void ignoredEventId;
    const payloadDigest = digest({ identity, snapshot });
    const dedupeKey = digest({
      installation: event.installationId, session: event.sessionId, task: event.taskId,
      cursor: event.endCursor, scope: event.scope, policy: event.policyVersion,
    });
    const eventKey = canonical([event.installationId, event.eventId]);
    return this.transaction(() => {
      const knownEvent = this.database.prepare("SELECT * FROM events WHERE event_key = ?").get(eventKey);
      if (knownEvent) {
        ensure(knownEvent.payload_digest === payloadDigest, "EVENT_COLLISION", "An event ID was reused with different evidence");
        return this.getJob(String(knownEvent.job_id));
      }
      const existing = this.database.prepare("SELECT id, payload_digest FROM jobs WHERE dedupe_key = ?").get(dedupeKey);
      if (existing) {
        ensure(existing.payload_digest === payloadDigest, "SNAPSHOT_COLLISION", "Task boundary was reused with different evidence");
      }
      const jobId = existing ? String(existing.id) : randomUUID();
      if (!existing) {
        this.database.prepare(`INSERT INTO jobs
          (id, dedupe_key, payload_digest, event_json, snapshot_json, snapshot_digest, status)
          VALUES (?, ?, ?, ?, ?, ?, 'queued')`).run(
          jobId, dedupeKey, payloadDigest, canonical(event), canonical(snapshot), digest(snapshot),
        );
        this.audit("job_queued", jobId);
      }
      this.database.prepare("INSERT INTO events(event_key, payload_digest, job_id) VALUES (?, ?, ?)")
        .run(eventKey, payloadDigest, jobId);
      return this.getJob(jobId);
    });
  }

  getJob(id: string): Job {
    const row = this.database.prepare("SELECT * FROM jobs WHERE id = ?").get(id);
    ensure(row, "NOT_FOUND", "Job not found");
    return this.jobFromRow(row);
  }

  private jobFromRow(row: Row): Job {
    return {
      id: String(row.id), event: decode<TaskEvent>(row.event_json),
      snapshot: decode<EvidenceSnapshot>(row.snapshot_json), snapshotDigest: String(row.snapshot_digest),
      status: String(row.status) as Job["status"],
      proposal: row.proposal_json ? decode<ProposalSet>(row.proposal_json) : null,
      receipt: row.receipt_json ? decode<CommitReceipt>(row.receipt_json) : null,
    };
  }

  saveProposal(jobId: string, input: unknown): Job {
    const proposal = parseProposal(input);
    return this.transaction(() => {
      const job = this.getJob(jobId);
      ensure(job.status === "queued", "JOB_STATE", "Only queued jobs accept a review result");
      checkProposal(proposal, job.event, job.snapshot);
      const status = proposal.operations.length ? "proposed" : "no_change";
      this.database.prepare("UPDATE jobs SET status = ?, proposal_json = ? WHERE id = ?")
        .run(status, canonical(proposal), jobId);
      this.audit(status, jobId);
      return this.getJob(jobId);
    });
  }

  cancel(jobId: string): void {
    this.transaction(() => {
      const job = this.getJob(jobId);
      if (job.status === "cancelled") return;
      ensure(job.status === "queued" || job.status === "proposed", "JOB_STATE", "Cannot cancel a terminal job");
      this.database.prepare("UPDATE jobs SET status = 'cancelled' WHERE id = ?").run(jobId);
      this.audit("cancelled", jobId);
    });
  }

  approve(jobId: string, approval: { actor: "user"; expectedProposalDigest: string } | { actor: "policy"; expectedProposalDigest: string; scope: Scope; policyId: string }): CommitReceipt {
    ensure(approval.actor === "user" || (approval.actor === "policy" && !!approval.policyId), "APPROVAL_REQUIRED", "Explicit approval or an authorized policy is required");
    return this.transaction(() => {
      const job = this.getJob(jobId);
      if (approval.actor === "policy") ensure(scopeKey(approval.scope) === scopeKey(job.event.scope), "SCOPE_DENIED", "Approval policy scope mismatch");
      ensure(job.proposal && digest(job.proposal) === approval.expectedProposalDigest, "APPROVAL_CHANGED", "Approval does not match the stored proposal");
      if (job.status === "committed") return job.receipt!;
      ensure(job.status === "proposed", "JOB_STATE", "Job is not awaiting approval");
      const proposal = parseProposal(job.proposal);
      checkProposal(proposal, job.event, job.snapshot);
      const revisions: CommitReceipt["revisions"] = [];
      for (const operation of proposal.operations) {
        const current = this.getItem(job.event.scope, operation.itemId);
        if (operation.action === "create") {
          ensure(!current, "REVISION_CONFLICT", `Item ${operation.itemId} already exists`);
        } else {
          ensure(current && current.revision === operation.expectedRevision, "REVISION_CONFLICT", `Item ${operation.itemId} changed`);
        }
        const content = operation.action === "archive"
          ? { ...current!, evidenceRefs: operation.evidenceRefs }
          : operation.content;
        const item: LearningItem = {
          ...content, id: operation.itemId, scope: job.event.scope,
          revision: (current?.revision ?? 0) + 1,
          lifecycle: operation.action === "archive" ? "archived" : "active",
          origin: { type: "review", id: jobId }, evidenceSourceJobId: jobId,
        };
        this.writeItem(item);
        revisions.push({ itemId: item.id, revision: item.revision });
      }
      const receipt = this.recordCommit(`review-${jobId}`, digest(proposal), job.event.scope, revisions);
      this.database.prepare("UPDATE jobs SET status = 'committed', receipt_json = ? WHERE id = ?")
        .run(canonical(receipt), jobId);
      this.audit("approved", canonical({ jobId, actor: approval.actor, policyId: approval.actor === "policy" ? approval.policyId : null }));
      return receipt;
    });
  }

  private writeItem(item: LearningItem): void {
    const key = scopeKey(item.scope);
    this.database.prepare(`INSERT INTO items(scope, id, revision, item_json) VALUES (?, ?, ?, ?)
      ON CONFLICT(scope, id) DO UPDATE SET revision = excluded.revision, item_json = excluded.item_json`)
      .run(key, item.id, item.revision, canonical(item));
    this.database.prepare("INSERT INTO revisions(scope, id, revision, item_json) VALUES (?, ?, ?, ?)")
      .run(key, item.id, item.revision, canonical(item));
    this.database.prepare("DELETE FROM items_search WHERE scope = ? AND id = ?").run(key, item.id);
    if (item.lifecycle === "active") {
      this.database.prepare("INSERT INTO items_search(scope, id, title, body) VALUES (?, ?, ?, ?)")
        .run(key, item.id, item.title, item.body);
    }
  }

  private recordCommit(id: string, requestDigest: string, scope: Scope, revisions: CommitReceipt["revisions"]): CommitReceipt {
    const result = this.database.prepare("INSERT INTO outbox(scope) VALUES (?)").run(scopeKey(scope));
    const receipt: CommitReceipt = { commitId: id, generation: Number(result.lastInsertRowid), revisions };
    this.database.prepare("INSERT INTO commits(id, request_digest, receipt_json) VALUES (?, ?, ?)")
      .run(id, requestDigest, canonical(receipt));
    this.audit("committed", id);
    return receipt;
  }

  getItem(scope: Scope, id: string): LearningItem | null {
    parseScope(scope);
    const row = this.database.prepare("SELECT item_json FROM items WHERE scope = ? AND id = ?").get(scopeKey(scope), id);
    return row ? decode<LearningItem>(row.item_json) : null;
  }

  list(scope: Scope): LearningItem[] {
    parseScope(scope);
    return this.database.prepare("SELECT item_json FROM items WHERE scope = ? ORDER BY id")
      .all(scopeKey(scope)).map(row => decode<LearningItem>(row.item_json));
  }

  history(scope: Scope, id: string): LearningItem[] {
    parseScope(scope);
    return this.database.prepare("SELECT item_json FROM revisions WHERE scope = ? AND id = ? ORDER BY revision")
      .all(scopeKey(scope), id).map(row => decode<LearningItem>(row.item_json));
  }

  query(scope: Scope, text: string, limit = 10): LearningItem[] {
    parseScope(scope);
    ensure(text.length <= 1000 && Number.isInteger(limit) && limit >= 1 && limit <= 50, "INVALID_INPUT", "Invalid query limits");
    const tokens = text.match(/[\p{L}\p{N}_]+/gu)?.slice(0, 20) ?? [];
    if (!tokens.length) return [];
    const expression = tokens.map(token => `"${token}"`).join(" AND ");
    return this.database.prepare(`SELECT id FROM items_search WHERE items_search MATCH ? AND scope = ?
      ORDER BY rank LIMIT ?`).all(expression, scopeKey(scope), limit)
      .map(row => this.getItem(scope, String(row.id))!);
  }

  revert(request: { commitKey: string; scope: Scope; itemId: string; expectedRevision: number; targetRevision: number }): CommitReceipt {
    parseScope(request.scope);
    ensure(/^[a-zA-Z0-9_-]{1,128}$/.test(request.commitKey), "INVALID_INPUT", "Invalid revert commit key");
    const commitId = `revert-${request.commitKey}`;
    const requestDigest = digest(request);
    return this.transaction(() => {
      const existing = this.database.prepare("SELECT * FROM commits WHERE id = ?").get(commitId);
      if (existing) {
        ensure(existing.request_digest === requestDigest, "COMMIT_COLLISION", "Commit key reused with different request");
        return decode<CommitReceipt>(existing.receipt_json);
      }
      const current = this.getItem(request.scope, request.itemId);
      ensure(current && current.revision === request.expectedRevision, "REVISION_CONFLICT", "Item changed before revert");
      ensure(Number.isInteger(request.targetRevision) && request.targetRevision >= 1 && request.targetRevision < current.revision, "INVALID_INPUT", "Revert target must be an earlier revision");
      const row = this.database.prepare("SELECT item_json FROM revisions WHERE scope = ? AND id = ? AND revision = ?")
        .get(scopeKey(request.scope), request.itemId, request.targetRevision);
      ensure(row, "NOT_FOUND", "Historical revision not found");
      const item: LearningItem = {
        ...decode<LearningItem>(row.item_json), revision: current.revision + 1,
        origin: { type: "revert", id: commitId },
      };
      this.writeItem(item);
      return this.recordCommit(commitId, requestDigest, request.scope, [{ itemId: item.id, revision: item.revision }]);
    });
  }

  preparePublication(scope: Scope): Publication | null {
    parseScope(scope);
    return this.transaction(() => {
      const row = this.database.prepare("SELECT MAX(generation) AS generation FROM outbox WHERE scope = ? AND status = 'pending'")
        .get(scopeKey(scope));
      if (!row?.generation) return null;
      return { scope, generation: Number(row.generation), items: this.list(scope).filter(item => item.lifecycle === "active") };
    });
  }

  acknowledgePublication(publication: Publication): void {
    this.database.prepare("UPDATE outbox SET status = 'published' WHERE scope = ? AND generation <= ?")
      .run(scopeKey(publication.scope), publication.generation);
  }
}
