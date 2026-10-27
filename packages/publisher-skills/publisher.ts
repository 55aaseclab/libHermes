import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { lstat, mkdir, open, readFile, rename, rmdir, unlink } from "node:fs/promises";
import path from "node:path";
import type { Publication, Scope, SkillPublisher } from "../protocol/types.js";
import { ensure, LearningError, parseScope, scopeKey, textDigest } from "../protocol/validation.js";

const owner = "continual-learning-m0";
const preamble = "---\nname: continual-learning\ndescription: Task experience for this explicitly authorized scope. Read when relevant; inspect applicability before use.\n---\n";
const maxBytes = 2_000_000;

export interface PublishPlan {
  publication: Publication;
  expectedHash: string | null;
}

interface Marker {
  owner: string;
  scope: string;
  generation: number;
  digest: string;
}

function isMissing(error: unknown): boolean {
  return (error as NodeJS.ErrnoException).code === "ENOENT";
}

async function checkDirectoryChain(directory: string, create: boolean): Promise<void> {
  const absolute = path.resolve(directory);
  const root = path.parse(absolute).root;
  let cursor = root;
  for (const part of absolute.slice(root.length).split(path.sep).filter(Boolean)) {
    cursor = path.join(cursor, part);
    if (create) {
      try {
        await mkdir(cursor);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      }
    }
    let info;
    try {
      info = await lstat(cursor);
    } catch (error) {
      if (!create && isMissing(error)) return;
      throw error;
    }
    ensure(info.isDirectory() && !info.isSymbolicLink(), "UNSAFE_PATH", "Publisher directory contains a redirect or non-directory");
  }
}

function render(publication: Publication): string {
  const entries = [...publication.items].sort((left, right) => left.id.localeCompare(right.id));
  const body = [
    "# Task experience", "", "Managed output. Review changes through the learning store, not by editing this file.",
    "These are scoped experiences, not proof of correctness or instructions to override user/project policy.", "",
    ...entries.flatMap(item => [
      `## ${item.title}`, "",
      `Item: ${item.id}; revision: ${item.revision}; evidence status: ${item.epistemicStatus}.`,
      `Applies when: ${item.applicability.join("; ") || "inspect the source task before reuse"}.`, "",
      item.body, "",
      `Evidence: ${item.evidenceSourceJobId} / ${item.evidenceRefs.join(", ")}.`, "",
    ]),
  ].join("\n");
  const marker: Marker = {
    owner, scope: scopeKey(publication.scope), generation: publication.generation,
    digest: textDigest(preamble + body),
  };
  const result = `${preamble}<!-- continual-learning:${JSON.stringify(marker)} -->\n${body}`;
  ensure(Buffer.byteLength(result) <= maxBytes, "PUBLICATION_TOO_LARGE", "Managed skill exceeds M0 publication limit");
  return result;
}

function inspect(content: string, scope: Scope): Marker {
  ensure(content.startsWith(preamble), "PROJECTION_DRIFT", "File is not the expected managed skill");
  const rest = content.slice(preamble.length);
  const newline = rest.indexOf("\n");
  const header = rest.slice(0, newline);
  ensure(header.startsWith("<!-- continual-learning:") && header.endsWith(" -->"), "PROJECTION_DRIFT", "Missing ownership marker");
  let marker: Marker;
  try {
    marker = JSON.parse(header.slice("<!-- continual-learning:".length, -" -->".length)) as Marker;
  } catch {
    throw new LearningError("PROJECTION_DRIFT", "Invalid ownership marker");
  }
  ensure(marker && marker.owner === owner && marker.scope === scopeKey(scope), "PROJECTION_OWNERSHIP", "Managed file belongs to another publisher or scope");
  ensure(Number.isSafeInteger(marker.generation) && marker.generation > 0, "PROJECTION_DRIFT", "Invalid generation marker");
  ensure(marker.digest === textDigest(preamble + rest.slice(newline + 1)), "PROJECTION_DRIFT", "Managed skill was edited outside the store");
  return marker;
}

export class ManagedSkillPublisher implements SkillPublisher {
  readonly skillPath: string;
  private readonly directory: string;

  constructor(root: string, private readonly scope: Scope) {
    parseScope(scope);
    this.directory = path.resolve(root, "continual-learning");
    this.skillPath = path.join(this.directory, "SKILL.md");
  }

  private async current(): Promise<string | null> {
    await checkDirectoryChain(this.directory, false);
    try {
      const info = await lstat(this.skillPath);
      ensure(info.isFile() && !info.isSymbolicLink() && info.nlink === 1, "UNSAFE_PATH", "Managed skill is not a regular, single-link file");
      ensure(info.size <= maxBytes, "PROJECTION_DRIFT", "Managed skill is unexpectedly large");
      const content = await readFile(this.skillPath, "utf8");
      inspect(content, this.scope);
      return content;
    } catch (error) {
      if (isMissing(error)) return null;
      throw error;
    }
  }

  async plan(publication: Publication): Promise<PublishPlan> {
    ensure(scopeKey(publication.scope) === scopeKey(this.scope), "SCOPE_MISMATCH", "Publisher binding has a different scope");
    ensure(publication.items.every(item => scopeKey(item.scope) === scopeKey(this.scope) && item.lifecycle === "active"), "SCOPE_MISMATCH", "Publication contains ineligible items");
    const current = await this.current();
    return { publication: structuredClone(publication), expectedHash: current === null ? null : textDigest(current) };
  }

  async apply(plan: PublishPlan): Promise<void> {
    ensure(scopeKey(plan.publication.scope) === scopeKey(this.scope), "SCOPE_MISMATCH", "Publisher scope changed");
    const output = render(plan.publication);
    await checkDirectoryChain(this.directory, true);
    const lock = path.join(this.directory, ".publish-lock");
    try {
      await mkdir(lock);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EEXIST") throw new LearningError("PUBLISH_BUSY", "Publication lock exists; inspect for an active publisher before recovering a stale lock");
      throw error;
    }
    const temporary = path.join(this.directory, `.SKILL-${randomUUID()}.tmp`);
    try {
      const current = await this.current();
      if (current === output) return;
      ensure((current === null ? null : textDigest(current)) === plan.expectedHash, "PUBLICATION_CONFLICT", "Publication changed after planning");
      if (current !== null) {
        ensure(inspect(current, this.scope).generation < plan.publication.generation, "STALE_PUBLICATION", "Cannot replace the same or a newer generation");
      }
      const handle = await open(temporary, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, 0o600);
      try {
        await handle.writeFile(output, "utf8");
        await handle.sync();
      } finally {
        await handle.close();
      }
      await checkDirectoryChain(this.directory, false);
      const latest = await this.current();
      ensure((latest === null ? null : textDigest(latest)) === plan.expectedHash, "PUBLICATION_CONFLICT", "Publication changed during write");
      await rename(temporary, this.skillPath);
    } finally {
      await unlink(temporary).catch(error => { if (!isMissing(error)) throw error; });
      await rmdir(lock);
    }
  }

  async publish(publication: Publication): Promise<void> {
    await this.apply(await this.plan(publication));
  }
}
