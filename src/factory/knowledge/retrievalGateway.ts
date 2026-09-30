import type { KnowledgeStore } from './knowledgeStore';

/**
 * RetrievalGateway seam (spec §11/§31). The one boundary through which a
 * worker's context is assembled: retrieval is read-only and distinct from
 * side effects, and every result carries provenance (source id/type/authority/
 * locator/timestamp/excerpt) so Evidence Bundles can attribute context. v0.1
 * ships the interface only — no retrieval backend is wired.
 */
export interface RetrievedSource {
  ref: string;
  authority: string;
  locator: string;
  excerpt: string;
  at: string;
}

export interface RetrievedContext {
  query: string;
  sources: RetrievedSource[];
}

export interface RetrievalGateway {
  /** Retrieve provenance-bearing context for one Task/Attempt. */
  retrieve(request: {
    workOrderId: string;
    taskId: string;
    query: string;
  }): Promise<RetrievedContext>;
  /** The knowledge backend this gateway reads from. */
  readonly knowledge: KnowledgeStore;
}
