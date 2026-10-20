import type { AcquisitionTermsMetadata } from "./contracts/acquisitionTerms.js";
export type AcquisitionRowFacts = Readonly<{
  id: string;
  active: boolean;
  regionCodes: readonly string[];
  validFrom: string;
  validTo: string | null;
  mirrorOf: unknown;
  metadataPresent: boolean;
  metadata: unknown;
}>;
export type AcquisitionClassification = Readonly<{
  baselineLegacy: boolean;
  target: boolean;
  canonicalRow: boolean;
  unconfiguredLegacyEligible: boolean;
}>;
/** Required host policy. No financial predicates or schedules are inferred. */
export interface AcquisitionFinancialPolicy<Row> {
  facts(row: Row): AcquisitionRowFacts;
  classify(row: Row): AcquisitionClassification;
  validateMetadata(row: Row, terms: AcquisitionTermsMetadata): void;
  pairMatches(legacy: Row, mirror: Row): boolean;
  initialDiscountBps(row: Row, purpose: "resolved_target" | "filter_validation"): unknown;
  unconfiguredTerms(legacy: Row, mirror: Row): AcquisitionTermsMetadata;
}
