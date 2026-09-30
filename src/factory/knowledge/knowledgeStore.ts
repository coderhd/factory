/**
 * KnowledgeStore seam (spec §19/§31; architecture
 * `factory-docs/architecture/context-memory-retrieval-architecture.md`).
 *
 * The Knowledge Plane is deliberately separate from execution state: durable,
 * searchable memory (docs, prior Attempt outcomes, preferences) that a worker
 * reads through the Retrieval Gateway and writes back to *explicitly* only
 * (spec §10 write-back ritual). v0.1 ships the interface only — no backend is
 * wired into the runtime yet, and no behaviour is implied here.
 */
export interface KnowledgeMatch {
  /** Stable locator within the knowledge plane (path or id). */
  path: string;
  excerpt: string;
  score: number;
}

export interface KnowledgeEntry {
  /** Caller-supplied source identity for the write-back. */
  ref: string;
  text: string;
}

export interface KnowledgeStore {
  /** Ranked matches for a query, scoped by an opaque caller-supplied scope. */
  search(query: string, scope?: Record<string, string>, k?: number): Promise<KnowledgeMatch[]>;
  /** Explicit write-back of evaluated knowledge — never an implicit side effect. */
  record(entry: KnowledgeEntry): Promise<void>;
}
