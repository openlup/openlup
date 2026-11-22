import type { CatalogAdmissionEvidence } from "@openlup/core/catalog";

/** Bound owner input for the assertion-only native catalogue port.
 * @experimental
 */
export interface CatalogAdmissionInput {
  mode: "one_time" | "subscription";
  context: { regionCode: string; currency: string; channel: string; policy: "not_applicable" };
  reviewedProjection: unknown;
  ownerDocument: Pick<CatalogAdmissionEvidence, "consultedHeads" | "offer" | "lineBindings" | "priceEvidenceRef" | "policyEvidenceRef">
    & { reviewedProjection: unknown };
  evidence: CatalogAdmissionEvidence;
}

/** Read and assert current facts on the already-fenced owner transaction.
 * @experimental
 */
export interface CatalogAdmissionPort {
  assertCurrent(db: { query(sql: string, values: unknown[]): Promise<unknown> }, input: CatalogAdmissionInput): Promise<void>;
}
