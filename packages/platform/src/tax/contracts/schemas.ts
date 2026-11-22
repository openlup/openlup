import { CatalogueMoneyV2Error, isCatalogueMoneyV2RateDecimal, planCatalogueMoneyV2 } from "@openlup/core/pricing";
import { array, checked, exclusiveTaxRemedy, invalid, object, oneOf, schema, unique, variant } from "./decode.js";
import type { Decode, Schema } from "./decode.js";
import { cellKey, compareCells, compareDeclarations, decisionIsPossible, declarationKey, includesInstant, permitsAssessment, sameCell } from "./identity.js";
import type {
  TaxCalculationEvidenceV1, TaxCalculationRefV1, TaxCloseReasonV1, TaxCommitRequestV1,
  TaxCoverageInputV1, TaxCoverageV1, TaxFiscalValidityRequestV1, TaxQuoteInputV1, TaxQuoteRequestV1, TaxReverseRequestV1, TaxScopeV1,
} from "./types.js";

function text(max: number): Decode<string> {
  return checked((value): value is string => typeof value === "string" && value.length > 0 && value.length <= max
    && !value.includes("\u0000") && !/[\uD800-\uDFFF]/u.test(value), "Supply nonempty Unicode text within " + max + " code units.");
}

export const ref = text(256);
export const moneyRef = text(128);
const addressText = text(512);
export const digest = checked((v): v is string => typeof v === "string" && v.length === 64 && /^[0-9a-f]+$/.test(v),
  "Supply a lowercase SHA-256 hex digest.");
export const instant = checked((v): v is string => typeof v === "string" && v.length === 24 && Number.isFinite(Date.parse(v))
  && new Date(v).toISOString() === v, "Supply a UTC instant with millisecond precision.");
const signed = checked((v): v is number => typeof v === "number" && Number.isSafeInteger(v) && !Object.is(v, -0),
  "Supply a safe integer.");
export const unsigned: Decode<number> = (value, field) => {
  const result = signed(value, field);
  if (result < 0) invalid(field, "Supply a nonnegative safe integer.");
  return result;
};
const boolean = checked((v): v is boolean => typeof v === "boolean", "Supply a boolean.");
export const rate = checked(isCatalogueMoneyV2RateDecimal,
  "Supply a decimal percent from 0 to 9007199254.740991 with up to six fractional digits and no extra leading zeros.");

const intervalFields = object({ from: instant }, { until: instant });
function checkInterval({ from, until }: Readonly<{ from: string; until?: string }>, field: string): void {
  if (until !== undefined && from >= until) invalid(field + "/until", "Supply an end after the start.");
}
export const interval: Decode<ReturnType<typeof intervalFields>> = (value, field) => {
  const parsed = intervalFields(value, field);
  checkInterval(parsed, field);
  return parsed;
};

export const scopeMode = oneOf("test", "live");
export const scope: Decode<TaxScopeV1> = object({ adapter: ref, adapterVersion: ref, accountRef: ref, mode: scopeMode });
const assignment = { taxClass: ref, assignmentRef: ref };
type Cell = TaxCoverageInputV1["required"][number];
export const targetKind = oneOf("line", "delivery", "fee");
const target = variant<Cell["target"]>("kind", {
  line: object({ kind: oneOf("line"), key: ref }),
  delivery: object({ kind: oneOf("delivery"), key: ref }),
  fee: object({ kind: oneOf("fee"), key: ref, ...assignment }, { deliveryKey: ref }),
});
export const cell: Decode<Cell> = object({ target, jurisdiction: ref, level: ref, taxKind: ref, sourcing: oneOf("destination", "ship_from") });
const declarationFields = { jurisdiction: ref, taxKind: ref, effective: intervalFields, actorRef: ref, recordedAt: instant };
type TaxDeclaration = TaxCoverageV1["declarations"][number];
export const declaration: Decode<TaxDeclaration> = variant<TaxDeclaration>("status", {
  registered: object({ ...declarationFields, status: oneOf("registered") }),
  not_registered_acknowledged: object({ ...declarationFields, status: oneOf("not_registered_acknowledged"), acknowledgementRef: ref }),
});
const registration = object({ state: oneOf("active", "inactive"), effective: intervalFields, evidenceRef: ref });
const treatment = object({ kind: oneOf("taxable", "exempt", "not_applicable"), reason: ref, ruleRef: ref });
const observationFields = object({ cell }, { registration, treatment, assessedMinor: unsigned });
const observation: typeof observationFields = (value, field) => {
  const parsed = observationFields(value, field);
  if (parsed.registration) checkInterval(parsed.registration.effective, field + "/registration/effective");
  return parsed;
};

const coverageFields = object({ schemaVersion: oneOf(1), accountRef: ref, revision: ref, declarations: array(declaration) });
function checkCoverage(parsed: TaxCoverageV1, field: string): void {
  parsed.declarations.forEach((entry, index) => checkInterval(entry.effective, field + "/declarations/" + index + "/effective"));
  const sorted = parsed.declarations.map((entry, index) => ({ entry, index }))
    .sort((a, b) => compareDeclarations(a.entry, b.entry));
  for (let i = 1; i < sorted.length; i++) {
    const prior = sorted[i - 1].entry, current = sorted[i].entry;
    if (declarationKey(prior) === declarationKey(current)
      && (prior.effective.until === undefined || current.effective.from < prior.effective.until)) {
      invalid(field + "/declarations/" + sorted[i].index + "/effective", "Use nonoverlapping declarations for this jurisdiction and tax kind.");
    }
  }
}

function coverage(value: unknown, field: string): TaxCoverageV1 {
  const parsed = coverageFields(value, field);
  checkCoverage(parsed, field);
  return parsed;
}

const cells = array(cell);
function requiredCells(value: unknown, field: string): readonly Cell[] {
  const rows = cells(value, field);
  unique(rows, cellKey, field);
  return rows;
}

export const taxCoverageV1Schema: Schema<TaxCoverageV1> = schema(coverage);
export const coverageInputSchema: Schema<TaxCoverageInputV1> = schema(
  object({ scope, taxDate: instant, coverage, required: requiredCells, observations: array(observation) }),
);

const adjustmentTarget = (value: unknown, field: string): { lineKeys: string[] } | { bucketKey: string } =>
  typeof value === "object" && value !== null && Object.hasOwn(value, "lineKeys")
    ? object({ lineKeys: array(moneyRef, 256) })(value, field) : object({ bucketKey: moneyRef })(value, field);
const moneyFields = object({
  amountBasis: oneOf("exclusive", "inclusive"),
  sources: array(object({ lineKey: moneyRef, sourceOrdinal: unsigned, quantity: unsigned, unitBasisMinor: unsigned }), 256),
  delivery: array(object({ bucketKey: moneyRef, deliveryKind: oneOf("shipping", "handling"), amountMinor: unsigned }), 256),
  adjustments: array(object({ adjustmentRef: moneyRef, sequence: unsigned, amountMinor: unsigned, target: adjustmentTarget }), 256),
  fees: array(checked((_v): _v is never => false, "Supply an empty list. The tax adapter determines fees."), 0),
});

type QuoteDocument = Omit<TaxQuoteInputV1, "money"> & {
  money: Omit<TaxQuoteInputV1["money"], "amountBasis"> & { amountBasis: "exclusive" | "inclusive" };
};
export function checkQuoteMoney(parsed: TaxQuoteInputV1["money"], field: string): void {
  try {
    const { components } = planCatalogueMoneyV2(parsed);
    const basis = components.reduce((sum, item) => sum + BigInt(item.effectiveMinor), 0n);
    if (basis > BigInt(Number.MAX_SAFE_INTEGER)) {
      invalid(field, "Reduce the post-adjustment merchandise and delivery basis to a safe integer.", "tax_amount_out_of_range");
    }
  } catch (error) {
    if (!(error instanceof CatalogueMoneyV2Error)) throw error;
    const pointer = error.field.replace(/\.preDiscountMinor$/, "").replace(/\[(\d+)\]/g, ".$1").replaceAll(".", "/");
    invalid(field + "/" + pointer, error.remedy, error.code === "money_amount_out_of_range" ? "tax_amount_out_of_range" : "tax_invalid_input");
  }
}

const line = object({ ...assignment, lineKey: moneyRef, sku: ref, mode: oneOf("one_time", "subscription") });
const delivery = object({
  ...assignment, bucketKey: moneyRef, carrierRef: ref, serviceRef: ref, separatelyStated: boolean,
  cost: object({ ref, currency: ref, amountMinor: unsigned }),
});
const address = object({ line1: addressText, city: addressText, postalCode: addressText, countryCode: addressText },
  { line2: addressText, subdivisionCode: addressText });
const destination = object({ snapshotRef: ref, digest, policyRevision: ref, address });
export const quotePurpose = oneOf("final", "estimate");
const quoteDocument = object({
  scope, market: ref, currency: ref, money: moneyFields, purpose: quotePurpose, taxDate: instant, destination,
  shipFromRef: ref, policyRevision: ref, classMapRevision: ref, lines: array(line, 256), delivery: array(delivery, 256),
  required: cells, coverage: coverageFields,
});

function bindComponents<T>(
  facts: readonly T[], keys: readonly string[], keyOf: (item: T) => string, field: string,
): Set<string> {
  unique(facts, keyOf, field);
  const expected = new Set(keys);
  facts.forEach((fact, index) => {
    if (!expected.has(keyOf(fact))) invalid(field + "/" + index, "Use a component key from the money input.");
  });
  if (facts.length !== expected.size) invalid(field, "Supply one tax fact for every money component.");
  return expected;
}

export function checkQuoteInput(parsed: QuoteDocument, field: string): asserts parsed is TaxQuoteInputV1 {
  if (parsed.money.amountBasis === "inclusive") invalid(field + "/money/amountBasis", exclusiveTaxRemedy, "tax_scope_mismatch");
  unique(parsed.required, cellKey, field + "/required");
  checkCoverage(parsed.coverage, field + "/coverage");
  if (parsed.coverage.accountRef !== parsed.scope.accountRef) {
    invalid(field + "/coverage/accountRef", "Supply coverage for the selected account.");
  }
  const lines = bindComponents(parsed.lines, parsed.money.sources.map(item => item.lineKey), item => item.lineKey, field + "/lines");
  const buckets = bindComponents(parsed.delivery, parsed.money.delivery.map(item => item.bucketKey), item => item.bucketKey, field + "/delivery");
  parsed.required.forEach(({ target }, index) => {
    const path = field + "/required/" + index + "/target";
    if (target.kind === "fee") {
      if (target.deliveryKey !== undefined && !buckets.has(target.deliveryKey)) invalid(path, "Use a selected delivery bucket.");
      return;
    }
    if (!(target.kind === "line" ? lines : buckets).has(target.key)) invalid(path, "Use a component key from the money input.");
  });
  const requiredTargets = new Set(parsed.required.map(({ target }) => JSON.stringify([target.kind, target.key])));
  if ([...lines].some(key => !requiredTargets.has(JSON.stringify(["line", key])))
    || [...buckets].some(key => !requiredTargets.has(JSON.stringify(["delivery", key])))) {
    invalid(field + "/required", "Supply a tax cell for every merchandise source and delivery bucket.");
  }
}

function quote(value: unknown, field: string): TaxQuoteInputV1 {
  const parsed = quoteDocument(value, field);
  checkQuoteInput(parsed, field);
  checkQuoteMoney(parsed.money, field + "/money");
  return parsed;
}

const quoteEnvelope = { key: ref, inputDigest: digest };
const quoteRequest = object({ ...quoteEnvelope, input: quote });
type QuoteRequestDocument = Omit<TaxQuoteRequestV1, "input"> & { input: QuoteDocument };
export const quoteRequestFields: Decode<QuoteRequestDocument> = object({ ...quoteEnvelope, input: quoteDocument });
export const taxQuoteRequestV1Schema: Schema<TaxQuoteRequestV1> = schema(quoteRequest);
export const quoteInputSchema: Schema<TaxQuoteInputV1> = schema(quote);
export const parseQuoteKey = (key: unknown): string => ref(key, "/key");

const coverageRow = object({
  cell, decision: oneOf("undeclared", "in_scope_taxed", "in_scope_exempt", "out_of_scope", "inconsistent", "unavailable_evidence"),
}, { declaration, registration, treatment });
const coverageEvidence = object({ vector: array(coverageRow), digest });
const resolution = object({ assignmentRef: ref, policyRevision: ref, sourceRef: ref, effective: intervalFields }, { sourceDigest: digest });
const position = object({
  positionRef: moneyRef, cell, taxabilityReason: ref, ruleRef: ref, resolution, resolutionDigest: digest,
}, { ratePercent: rate, providerLineRef: ref });
type Fee = TaxCalculationEvidenceV1["positions"]["fees"][number];
const feeScope = variant<Fee["scope"]>("kind", {
  order: object({ kind: oneOf("order") }),
  delivery: object({ kind: oneOf("delivery"), key: ref }),
});
const fee = object({ feeKey: moneyRef, jurisdiction: ref, feeKind: ref, scope: feeScope,
  refundRule: object({ ref, revision: ref }) }, { providerPositionRef: ref });
export const evidenceFields: Decode<TaxCalculationEvidenceV1> = object({
  requestKey: ref, scope, calculationRef: ref, status: quotePurpose, calculatedAt: instant, expiresAt: instant, taxDate: instant,
  destinationDigest: digest, shipFromRef: ref, inputDigest: digest, policyRevision: ref, classMapRevision: ref,
  coverage: coverageEvidence, fiscalDigest: digest, positions: object({ tax: array(position), fees: array(fee) }),
}, { providerLines: array(object({ lineKey: ref, providerLineRef: ref })) });

export function checkEvidence(parsed: TaxCalculationEvidenceV1, field: string): void {
  if (parsed.calculatedAt >= parsed.expiresAt) invalid(field + "/expiresAt", "Supply an expiry after calculation.");
  const { vector } = parsed.coverage;
  vector.forEach((row, index) => {
    const path = field + "/coverage/vector/" + index;
    if (index > 0 && compareCells(vector[index - 1].cell, row.cell) >= 0) invalid(path, "Supply uniquely ordered coverage cells.");
    if (row.declaration) checkInterval(row.declaration.effective, path + "/declaration/effective");
    if (row.registration) checkInterval(row.registration.effective, path + "/registration/effective");
  });
  parsed.positions.tax.forEach((row, index) => checkInterval(row.resolution.effective, field + "/positions/tax/" + index + "/resolution/effective"));
  if (parsed.providerLines) {
    unique(parsed.providerLines, item => item.lineKey, field + "/providerLines", "tax_breakdown_incomplete");
    unique(parsed.providerLines, item => item.providerLineRef, field + "/providerLines", "tax_breakdown_incomplete");
  }
  unique(parsed.positions.tax, item => item.positionRef, field + "/positions/tax", "tax_breakdown_incomplete");
  unique(parsed.positions.fees, item => item.feeKey, field + "/positions/fees", "tax_breakdown_incomplete");
}

export function reconcileEvidence(parsed: TaxCalculationEvidenceV1, field: string, join: "browser" | "fiscal" | "money"): void {
  const { vector } = parsed.coverage;
  vector.forEach((row, index) => {
    const path = field + "/coverage/vector/" + index;
    if (row.declaration && (declarationKey(row.declaration) !== declarationKey(row.cell)
      || !includesInstant(row.declaration.effective, parsed.taxDate))) invalid(path + "/declaration", "Supply the effective declaration for this cell.");
    if (row.registration && !includesInstant(row.registration.effective, parsed.taxDate)) {
      invalid(path + "/registration", "Supply the registration effective on the tax date.");
    }
    if ((parsed.status === "final" && !permitsAssessment("tax", row.decision, 0))
      || ((join !== "browser" || permitsAssessment("tax", row.decision, 0)) && !decisionIsPossible(row))) {
      invalid(path + "/decision", "Reconcile the named cell from effective observations.", "tax_calculation_unusable");
    }
  });
  const cells = new Map(vector.map(row => [cellKey(row.cell), row]));
  const code = join === "fiscal" ? "tax_breakdown_incomplete" : "tax_invalid_input";
  parsed.positions.tax.forEach((item, index) => {
    const bound = cells.get(cellKey(item.cell));
    const path = field + "/positions/tax/" + index;
    if (join !== "money" && (!bound || item.cell.target.kind === "fee" || !sameCell(bound.cell, item.cell)
      || !permitsAssessment("tax", bound.decision, 0))) invalid(path + "/cell", "Bind the position to a resolved tax cell.", code);
    if (!includesInstant(item.resolution.effective, parsed.taxDate)) {
      invalid(path + "/resolution/effective", "Supply a rule resolution effective on the tax date.");
    }
  });
  if (join !== "money") parsed.positions.fees.forEach((item, index) => {
    const key = JSON.stringify(["fee", item.feeKey, item.jurisdiction, item.feeKind]);
    const bound = cells.get(key);
    if (bound?.cell.target.kind !== "fee" || !permitsAssessment("fee", bound.decision, 0)
      || bound.cell.target.deliveryKey !== (item.scope.kind === "delivery" ? item.scope.key : undefined)) {
      invalid(field + "/positions/fees/" + index, "Bind the fee to the matching in-scope fee cell.", code);
    }
  });
}

function evidence(value: unknown, field: string): TaxCalculationEvidenceV1 {
  const parsed = evidenceFields(value, field);
  checkEvidence(parsed, field);
  reconcileEvidence(parsed, field, "browser");
  return parsed;
}
export const taxCalculationEvidenceV1Schema: Schema<TaxCalculationEvidenceV1> = schema(evidence);

const validityEnvelope = { evidenceDigest: digest, chargeAt: instant };
type FiscalValidityDocument = Omit<TaxFiscalValidityRequestV1, "original" | "current"> & {
  original: QuoteRequestDocument; current: QuoteDocument;
};
export const fiscalValidityFields: Decode<FiscalValidityDocument> =
  object({ original: quoteRequestFields, evidence: evidenceFields, ...validityEnvelope, current: quoteDocument });
const validityFields = object({ original: quoteRequest, evidence, ...validityEnvelope, current: quote });
export function checkChargeDate(parsed: TaxFiscalValidityRequestV1): void {
  if (parsed.current.taxDate !== parsed.chargeAt) invalid("/current/taxDate", "Use the charge instant as the current fiscal date.");
}
export const taxFiscalValidityRequestV1Schema: Schema<TaxFiscalValidityRequestV1> = schema((value, field) => {
  const parsed = validityFields(value, field);
  checkChargeDate(parsed);
  return parsed;
});

const calculationRef = object({ scope, ref, evidenceDigest: digest });
const closeReason = object({ kind: oneOf("affirmatively_unused", "verified_unpaid"), evidenceRef: ref });
const intent = oneOf("apply", "recover");
export const taxCloseInputV1Schema: Schema<{ ref: TaxCalculationRefV1; reason: TaxCloseReasonV1; key: string }> =
  schema(object({ ref: calculationRef, reason: closeReason, key: ref }));
const commitFields = object({ calculationRef, transactionRef: ref, postedAt: instant, capturedAt: instant, captureEvidenceRef: ref, intent });
export const taxCommitRequestV1Schema: Schema<TaxCommitRequestV1> = schema((value, field) => {
  const result = commitFields(value, field);
  if (result.postedAt < result.capturedAt) invalid("/postedAt", "Supply a posting time on or after verified capture.");
  return result;
});

const delta = object({ originalPositionRef: ref, netDeltaMinor: signed, taxDeltaMinor: signed, feeDeltaMinor: signed });
const reverseFields = {
  scope, originalRef: ref, reversalRef: ref, refundEvidenceRef: ref, currency: ref, fromMinor: unsigned, toMinor: unsigned,
  intent, positions: array(delta),
};
const feeEvidence = { feeEvidenceRef: ref };
const reverse = variant<TaxReverseRequestV1>("mode", {
  full: object({ ...reverseFields, mode: oneOf("full") }, feeEvidence),
  lines: object({ ...reverseFields, mode: oneOf("lines") }, feeEvidence),
  amount: object({ ...reverseFields, mode: oneOf("amount"), amountMinor: unsigned }, feeEvidence),
});
export const taxReverseRequestV1Schema: Schema<TaxReverseRequestV1> = schema((value, field) => {
  const result = reverse(value, field);
  if (result.fromMinor >= result.toMinor) invalid("/toMinor", "Supply an increased cumulative refund amount.");
  if (result.mode === "amount" && result.amountMinor !== result.toMinor - result.fromMinor) {
    invalid("/amountMinor", "Use the reserved increase in cumulative refund amount.");
  }
  if (!result.positions.length) invalid("/positions", "Supply the positions that substantiate the reserved reversal.");
  unique(result.positions, item => item.originalPositionRef, "/positions");
  let total = 0n;
  result.positions.forEach((position, index) => {
    for (const key of ["netDeltaMinor", "taxDeltaMinor", "feeDeltaMinor"] as const) {
      const amount = position[key];
      if (amount > 0) invalid("/positions/" + index + "/" + key, "Use a nonpositive reversal delta.");
      total += BigInt(amount);
    }
  });
  if (total !== -BigInt(result.toMinor - result.fromMinor)) {
    invalid("/positions", "Reconcile the position deltas to the reserved cumulative increase.");
  }
  if (result.feeEvidenceRef === undefined && result.positions.some(item => item.feeDeltaMinor !== 0)) {
    invalid("/feeEvidenceRef", "Supply the evidence authorizing the fee reversal.");
  }
  return result;
});
