type Mode = "one_time" | "subscription";
type TaxPosition = Readonly<{
  positionRef: string;
  jurisdictionRef: string;
  level: string;
  taxKind: string;
  rateDecimal?: string;
  taxableMinor: number;
  taxMinor: number;
  taxabilityReason: string;
  ruleRef: string;
  resolution: { assignmentRef: string; policyRevision: string; sourceRef: string; sourceDigest?: string;
    effective: { from: string; until?: string } };
  resolutionDigest: string;
  providerLineRef?: string;
}>;
type State = Readonly<{ basisMinor: number; netMinor: number; taxMinor: number; taxPositions: readonly TaxPosition[] }>;
type Allocation = Readonly<{
  allocationId: string; adjustmentRef: string; sequence: number; source: "legacy_promotion";
  basisReductionMinor: number; netReductionMinor: number; taxReductionMinor: number; evidenceRef: string;
  before: State; after: State;
}>;
type Component = Readonly<{
  preDiscountMinor: number; effectiveMinor: number; discountAllocations: readonly Allocation[];
  taxPositions: readonly TaxPosition[]; netMinor: number; taxMinor: number; lineTotalMinor: number;
}>;
type Line = Component & Readonly<{
  lineKey: string; sourceOrdinal: number; sku: string; mode: Mode; quantity: number;
  unitBasisMinor: number; taxClassKey: string; assignmentRef: string;
}>;
type Bucket = Readonly<{
  bucketKey: string; kind: "shipping" | "handling"; taxClassKey: string; assignmentRef: string;
  carrierRef: string; serviceRef: string; cost: { ref: string; currency: string; amountMinor: number }; separatelyStated: boolean;
  parts: readonly (Component & { sourceOrdinal?: number })[];
}>;
type Fee = Readonly<{
  feeKey: string; jurisdictionRef: string; feeKind: string; amountMinor: number;
  scope: { kind: "order" } | { kind: "delivery"; bucketKey: string };
  refundRule: { ref: string; revision: string }; providerPositionRef?: string;
}>;
type TaxEvidence = Readonly<{ calculationId: string; evidenceDigest: string; taxDate: string; expiresAt: string }>;
type PromotionEngineVersion = "promotion-engine.v1" | "promotion-engine.v2";

/** @beta @experimental Shared money facts committed by quotes and retained by orders. */
export type CommerceMoneyBodyV2 = Readonly<{
  currency: string;
  price: { priceListRef: string; priceContextDigest: string; priceEvidenceRef: string; classMapRevision: string };
  catalogueEvidenceRef: string;
  mode: Mode;
  cadence?: { schemaVersion: 1; kind: "fixed_days"; days: number };
  destination: { snapshotRef: string; schemaVersion: 2; destinationDigest: string; policyRevision: string };
  deliverySelectionRef: string;
  lines: readonly Line[];
  deliveryBuckets: readonly Bucket[];
  feeLines: readonly Fee[];
  netTotal: number;
  taxTotal: number;
  feeTotal: number;
  payableMinor: number;
  coverageDigest: string;
  paymentLimits: { profileRef: string; revision: string; channelKey: string; currency: string; minMinor: number; maxMinor: number };
}> & (
  | Readonly<{ amountBasis: "inclusive"; promotion: { engine: PromotionEngineVersion; rankingRuleRef: "lowest_payable_gross" };
      taxEvidence: TaxEvidence & { kind: "fiscal_profile" } }>
  | Readonly<{ amountBasis: "exclusive"; promotion: { engine: PromotionEngineVersion; rankingRuleRef: "lowest_pre_tax.v1" };
      taxEvidence: TaxEvidence & { kind: "tax_calculation" } }>
);
