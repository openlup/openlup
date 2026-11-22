import type { CatalogueMoneyV2Input, CatalogueMoneyV2Result } from "@openlup/core/pricing";

type List<T> = readonly T[];
type Interval = Readonly<{ from: string; until?: string }>;
type Sourcing = "destination" | "ship_from";
type Target = Readonly<{ kind: "line" | "delivery"; key: string }>
  | Readonly<{ kind: "fee"; key: string; taxClass: string; assignmentRef: string; deliveryKey?: string }>;
type Cell = Readonly<{ target: Target; jurisdiction: string; level: string; taxKind: string; sourcing: Sourcing }>;
type ClassAssignment = Readonly<{ taxClass: string; assignmentRef: string }>;
type Line = ClassAssignment & Readonly<{ lineKey: string; sku: string; mode: "one_time" | "subscription" }>;
type Delivery = ClassAssignment & Readonly<{ bucketKey: string; carrierRef: string; serviceRef: string;
  separatelyStated: boolean; cost: Readonly<{ ref: string; currency: string; amountMinor: number }> }>;
type Destination = Readonly<{ snapshotRef: string; digest: string; policyRevision: string;
  address: Readonly<{ line1: string; line2?: string; city: string; subdivisionCode?: string; postalCode: string; countryCode: string }> }>;
type Declaration = Readonly<{ jurisdiction: string; taxKind: string; effective: Interval; actorRef: string; recordedAt: string }>
  & (Readonly<{ status: "registered" }> | Readonly<{ status: "not_registered_acknowledged"; acknowledgementRef: string }>);
type Registration = Readonly<{ state: "active" | "inactive"; effective: Interval; evidenceRef: string }>;
type Treatment = Readonly<{ kind: "taxable" | "exempt" | "not_applicable"; reason: string; ruleRef: string }>;
type Observation = Readonly<{ cell: Cell; registration?: Registration; treatment?: Treatment; assessedMinor?: number }>;
type Resolution = Readonly<{ assignmentRef: string; policyRevision: string; sourceRef: string; sourceDigest?: string; effective: Interval }>;
type Assessed = Readonly<{ positionRef: string; cell: Cell; ratePercent?: string; taxabilityReason: string;
  ruleRef: string; resolution: Resolution; resolutionDigest: string; providerLineRef?: string }>;
type Fee = Readonly<{ feeKey: string; jurisdiction: string; feeKind: string;
  scope: Readonly<{ kind: "order" }> | Readonly<{ kind: "delivery"; key: string }>;
  refundRule: Readonly<{ ref: string; revision: string }>; providerPositionRef?: string }>;

export type TaxScopeV1 = Readonly<{ adapter: string; adapterVersion: string; accountRef: string; mode: "test" | "live" }>;
export type TaxCoverageV1 = Readonly<{ schemaVersion: 1; accountRef: string; revision: string; declarations: List<Declaration> }>;
type CoverageDecision = "undeclared" | "in_scope_taxed" | "in_scope_exempt" | "out_of_scope"
  | "inconsistent" | "unavailable_evidence";
export type TaxCoverageInputV1 = Readonly<{ scope: TaxScopeV1; taxDate: string; coverage: TaxCoverageV1;
  required: List<Cell>; observations: List<Observation> }>;
type CoverageRow = Readonly<{ cell: Cell; decision: CoverageDecision; declaration?: Declaration;
  registration?: Registration; treatment?: Treatment }>;
type CoverageEvidence = Readonly<{ vector: List<CoverageRow>; digest: string }>;
export type TaxCoverageResultV1 = CoverageEvidence & (
  Readonly<{ kind: "resolved"; posting: "required" | "skip" }> | TaxRefusal | TaxUnavailable);

export type TaxQuoteInputV1 = Readonly<{ scope: TaxScopeV1; market: string; currency: string; money: CatalogueMoneyV2Input & { readonly amountBasis: "exclusive" };
  purpose: "final" | "estimate"; taxDate: string; destination: Destination; shipFromRef: string;
  policyRevision: string; classMapRevision: string; lines: List<Line>; delivery: List<Delivery>;
  required: List<Cell>; coverage: TaxCoverageV1 }>;
export type TaxQuoteRequestV1 = Readonly<{ key: string; inputDigest: string; input: TaxQuoteInputV1 }>;
/**
 * Hash digests as lowercase SHA-256 hex over the UTF-8 bytes of
 * `canonicalCatalogDraftJson([tag, payload])` from `@openlup/platform/catalog/contracts`.
 * Use these tags and payloads.
 *
 * - `platform.tax.input.v1` binds the quote input, with required cells and
 *   declarations sorted by identity as in `makeTaxQuoteRequest`.
 * - `platform.tax.coverage.v1` binds `coverage.vector` as returned by `reconcileTaxCoverage`.
 * - `platform.tax.resolution.v1` binds each tax row's `resolution`.
 * - `platform.tax.fiscal.v1` binds `{ scope, destinationDigest, shipFromRef,
 *   policyRevision, classMapRevision, coverage, tax, fees }`. Use the coverage
 *   vector for `coverage`, the tax rows with `resolutionDigest` and
 *   `providerLineRef` omitted for `tax`, and the fee rows for `fees`.
 *   This payload excludes the calculation ref, times and expiry.
 * - `platform.tax.evidence.v1` binds this whole evidence object.
 *
 * Supply one metadata row per emitted assessment, including zero amounts.
 * A taxed coverage cell may have no emitted position.
 */
export type TaxCalculationEvidenceV1 = Readonly<{
  scope: TaxScopeV1; calculationRef: string; status: "final" | "estimate"; calculatedAt: string;
  expiresAt: string; taxDate: string; destinationDigest: string; shipFromRef: string; inputDigest: string;
  policyRevision: string; classMapRevision: string; coverage: CoverageEvidence; fiscalDigest: string;
  positions: Readonly<{ tax: List<Assessed>; fees: List<Fee> }>;
}>;
type QuoteSuccess<K extends TaxCalculationEvidenceV1["status"]> = Readonly<{
  kind: K; money: CatalogueMoneyV2Result; evidence: TaxCalculationEvidenceV1 & { readonly status: K }; evidenceDigest: string;
}>;
export type TaxQuoteResultV1 = QuoteSuccess<"final"> | QuoteSuccess<"estimate">
  | ((TaxRefusal | TaxUnavailable) & Readonly<{ coverage?: CoverageEvidence }>);

export type TaxFiscalValidityRequestV1 = Readonly<{ original: TaxQuoteRequestV1; evidence: TaxCalculationEvidenceV1;
  evidenceDigest: string; chargeAt: string; current: TaxQuoteInputV1 }>;
type FiscalProof = Readonly<{ calculationRef: string; evidenceDigest: string; observedAt: string;
  effective: Interval; fiscalDigest: string; dispatchBefore: string }>;
export type TaxFiscalValidityResultV1 = Readonly<{ kind: "unchanged" | "changed"; proof: FiscalProof }> | TaxUnavailable;

export type TaxCalculationRefV1 = Readonly<{ scope: TaxScopeV1; ref: string; evidenceDigest: string }>;
export type TaxCloseReasonV1 = Readonly<{ kind: "affirmatively_unused" | "verified_unpaid"; evidenceRef: string }>;
export type TaxCloseResultV1 = Readonly<{ kind: "closed"; ref: TaxCalculationRefV1; key: string }> | TaxRefusal | TaxUnavailable;
export type TaxCommitRequestV1 = Readonly<{ calculationRef: TaxCalculationRefV1; transactionRef: string;
  postedAt: string; capturedAt: string; captureEvidenceRef: string; intent: "apply" | "recover" }>;
type PositionMapping = Readonly<{ originalPositionRef: string; postedPositionRef: string }>;
export type TaxCommitResultV1 = Readonly<{ kind: "committed"; providerTransactionRef: string;
  positions: List<PositionMapping> }> | TaxRefusal | TaxUnavailable;
type Delta = Readonly<{ originalPositionRef: string; netDeltaMinor: number; taxDeltaMinor: number; feeDeltaMinor: number }>;
/** The refund-reservation ledger owner verifies per-original-position caps and cumulative balances under its lock. */
export type TaxReverseRequestV1 = Readonly<{ scope: TaxScopeV1; originalRef: string; reversalRef: string;
  refundEvidenceRef: string; currency: string; fromMinor: number; toMinor: number; intent: "apply" | "recover";
  positions: List<Delta>; feeEvidenceRef?: string }>
  & (Readonly<{ mode: "full" | "lines" }> | Readonly<{ mode: "amount"; amountMinor: number }>);
export type TaxReverseResultV1 = Readonly<{ kind: "reversed"; providerReversalRef: string; positions: List<Delta> }>
  | TaxRefusal | TaxUnavailable;
export type TaxCapabilitiesV1 = Readonly<{ scope: TaxScopeV1; markets: List<string>; currencies: List<string>;
  /** Inclusive bases are not supported by this contract version. */
  bases: readonly ["exclusive"]; sourcing: List<Sourcing>;
  evidence: Readonly<{ lines: boolean; delivery: boolean; fees: boolean }>;
  registrations: "effective_intervals" | "unsupported"; validity: "read_only" | "unsupported";
  calculationLifetimeMs: number; posting: "provider" | "unsupported"; reversals: List<"full" | "lines" | "amount">;
  recovery: List<"commit" | "reverse"> }>;

export type TaxRefusalCode = "tax_invalid_input" | "tax_scope_mismatch" | "tax_class_missing" | "tax_rule_missing"
  | "tax_coverage_undeclared" | "tax_coverage_inconsistent" | "tax_breakdown_incomplete" | "tax_amount_out_of_range"
  | "tax_reference_conflict" | "tax_calculation_unusable" | "tax_calculation_expired" | "tax_calculation_closed"
  | "tax_close_not_eligible" | "tax_operation_unsupported" | "tax_reversal_unsubstantiated";
export interface TaxRefusal {
  readonly kind: "refused"; readonly code: TaxRefusalCode; readonly field: string; readonly remedy: string;
  readonly jurisdiction?: string; readonly taxKind?: string;
}
export interface TaxUnavailable {
  readonly kind: "unavailable";
  readonly code: "tax_coverage_evidence_unavailable" | "tax_fiscal_validity_unavailable" | "tax_adapter_unavailable";
  readonly effect: "none" | "unknown";
}
