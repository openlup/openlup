import type { SizedAgreedLine, SizedEditContext, SizedEditPolicy, SizedQuoteRequest, SizedRecurringQuote } from "./contracts/sizedEdit.js";
import type { SubscriptionQueryExecutor } from "./postgresRenewalStore.js";

/** Host verifies its current documents and translates physical, demand and exclusion facts.
 * Retained withdrawn identities must be resolved exactly, independently of discovery. */
export interface SizedCatalogFact {
  variantId: string; sku: string; groupId: string; isAddon: boolean; sellable: boolean;
  physicalSize: number; demandPerUnit: number; documentRevisionId: string; documentDigest: string; verified: boolean;
  exclusions: readonly string[] | null; sellableNow: number | null;
}
export interface SizedSubjectFacts {
  subscriptionId: string; clientId: string; subjectRef: string; exclusions: string[]; snapshot: Record<string, unknown>;
}
export interface SizedHostPorts {
  /** Candidate discovery is advisory; preview/apply reread authenticated owned facts. Precedence is host-owned. */
  readFacts(db: SubscriptionQueryExecutor, context: SizedEditContext, point: "candidate" | "preview" | "apply"): Promise<SizedSubjectFacts>;
  /** Only opt-in derives fresh need. Ordinary edits use the stored dailyNeed carrier. */
  resolveOptInNeed(db: SubscriptionQueryExecutor, context: SizedEditContext): Promise<{ dailyNeed: number; snapshot: Record<string, unknown> }>;
  readCatalog(db: SubscriptionQueryExecutor, context: SizedEditContext): Promise<SizedCatalogFact[]>;
  /** On this transaction connection, lock and reread owned subject rows and the optional opt-in
   * need, and reread every selected catalogue fact (including stock). Compare with the supplied
   * evidence; a mismatch throws subscription_edit_invalid_subject_snapshot. Subject locks hold
   * through commit. Catalogue rows are reread, not locked: a restricted runtime may only read
   * them, and serializing against a concurrent catalogue publication is the publication-fence
   * limit. Catalogue evidence is ordered by canonical variant UUID, with sorted exclusion keys. */
  assertCurrentFacts(db: SubscriptionQueryExecutor, context: SizedEditContext, expected: SizedSubjectFacts,
    optInNeed: Record<string, unknown> | null, catalogFacts: readonly SizedCatalogFact[]): Promise<void>;
  proposePortion(input: { dailyNeed: number; cadenceDays: number; factor: number;
    current: SizedAgreedLine[]; catalog: readonly SizedCatalogFact[] }): Promise<{ variantId: string; qty: number }[]>;
  quotePort: { createServerAuthoritativeQuote(request: SizedQuoteRequest & { compositionConstraint: Record<string, unknown> }): Promise<{ quote: SizedRecurringQuote }> };
}
export interface SizedEditorOptions extends SizedHostPorts {
  policy: SizedEditPolicy;
  withTransaction<T>(work: (db: SubscriptionQueryExecutor) => Promise<T>): Promise<T>;
  now(): string;
}
