import { CatalogueMoneyV2Error, isCatalogueMoneyV2RateDecimal, planCatalogueMoneyV2 } from "@openlup/core/pricing";
import { array, checked, exclusiveTaxRemedy, invalid, object, oneOf, schema, unique, variant } from "./decode.js";
import type { Decode, Schema } from "./decode.js";
import { cellKey, compareCells, compareDeclarations, decisionIsPossible, declarationKey, includesInstant, permitsAssessment, sameCell } from "./identity.js";
import type {
  TaxCalculationEvidenceV1, TaxCalculationRefV1, TaxCloseReasonV1, TaxCommitRequestV1,
  TaxCoverageInputV1, TaxCoverageV1, TaxFiscalValidityRequestV1, TaxQuoteInputV1, TaxQuoteRequestV1, TaxReverseRequestV1,
} from "./types.js";

function text(max: number): Decode<string> {
  return checked((value): value is string => typeof value === "string" && value.length > 0 && value.length <= max
    && !value.includes("\u0000") && !/[\uD800-\uDFFF]/u.test(value), "Supply nonempty Unicode text within " + max + " code units.");
}

const ref = text(256);
const moneyRef = text(128);
const addressText = text(512);
const digest = checked((v): v is string => typeof v === "string" && v.length === 64 && /^[0-9a-f]+$/.test(v),
  "Supply a lowercase SHA-256 hex digest.");
const instant = checked((v): v is string => typeof v === "string" && v.length === 24 && Number.isFinite(Date.parse(v))
  && new Date(v).toISOString() === v, "Supply a UTC instant with millisecond precision.");
const signed = checked((v): v is number => typeof v === "number" && Number.isSafeInteger(v) && !Object.is(v, -0),
  "Supply a safe integer.");
const unsigned: Decode<number> = (value, field) => {
  const result = signed(value, field);
  if (result < 0) invalid(field, "Supply a nonnegative safe integer.");
  return result;
};
const boolean = checked((v): v is boolean => typeof v === "boolean", "Supply a boolean.");
const rate = checked(isCatalogueMoneyV2RateDecimal,
  "Supply a decimal percent from 0 to 9007199254.740991 with up to six fractional digits and no extra leading zeros.");

const intervalFields = object({ from: instant }, { until: instant });
const interval: Decode<ReturnType<typeof intervalFields>> = (value, field) => {
  const parsed = intervalFields(value, field);
  if (parsed.until !== undefined && parsed.from >= parsed.until) invalid(field + "/until", "Supply an end after the start.");
  return parsed;
};

const scope = object({ adapter: ref, adapterVersion: ref, accountRef: ref, mode: oneOf("test", "live") });
const assignment = { taxClass: ref, assignmentRef: ref };
type Cell = TaxCoverageInputV1["required"][number];
const target = variant<Cell["target"]>("kind", {
  line: object({ kind: oneOf("line"), key: ref }),
  delivery: object({ kind: oneOf("delivery"), key: ref }),
  fee: object({ kind: oneOf("fee"), key: ref, ...assignment }, { deliveryKey: ref }),
});
const cell = object({ target, jurisdiction: ref, level: ref, taxKind: ref, sourcing: oneOf("destination", "ship_from") });
const declarationFields = { jurisdiction: ref, taxKind: ref, effective: interval, actorRef: ref, recordedAt: instant };
const declaration = variant<TaxCoverageV1["declarations"][number]>("status", {
  registered: object({ ...declarationFields, status: oneOf("registered") }),
  not_registered_acknowledged: object({ ...declarationFields, status: oneOf("not_registered_acknowledged"), acknowledgementRef: ref }),
});
const registration = object({ state: oneOf("active", "inactive"), effective: interval, evidenceRef: ref });
const treatment = object({ kind: oneOf("taxable", "exempt", "not_applicable"), reason: ref, ruleRef: ref });
const observation = object({ cell }, { registration, treatment, assessedMinor: unsigned });

const coverageFields = object({ schemaVersion: oneOf(1), accountRef: ref, revision: ref, declarations: array(declaration) });
function coverage(value: unknown, field: string): TaxCoverageV1 {
  const parsed = coverageFields(value, field);
  const sorted = parsed.declarations.map((entry, index) => ({ entry, index }))
    .sort((a, b) => compareDeclarations(a.entry, b.entry));
  for (let i = 1; i < sorted.length; i++) {
    const prior = sorted[i - 1].entry, current = sorted[i].entry;
    if (declarationKey(prior) === declarationKey(current)
      && (prior.effective.until === undefined || current.effective.from < prior.effective.until)) {
      invalid(field + "/declarations/" + sorted[i].index + "/effective", "Use nonoverlapping declarations for this jurisdiction and tax kind.");
    }
  }
  return parsed;
}

function requiredCells(value: unknown, field: string): readonly Cell[] {
  const rows = array(cell)(value, field);
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
  amountBasis(value: unknown, field: string) {
    if (value === "inclusive") invalid(field, exclusiveTaxRemedy, "tax_scope_mismatch");
    return oneOf("exclusive")(value, field);
  },
  sources: array(object({ lineKey: moneyRef, sourceOrdinal: unsigned, quantity: unsigned, unitBasisMinor: unsigned }), 256),
  delivery: array(object({ bucketKey: moneyRef, deliveryKind: oneOf("shipping", "handling"), amountMinor: unsigned }), 256),
  adjustments: array(object({ adjustmentRef: moneyRef, sequence: unsigned, amountMinor: unsigned, target: adjustmentTarget }), 256),
  fees: array(checked((_v): _v is never => false, "Supply an empty list. The tax adapter determines fees."), 0),
});

function money(value: unknown, field: string): TaxQuoteInputV1["money"] {
  const parsed = moneyFields(value, field);
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
  return parsed;
}

const line = object({ ...assignment, lineKey: moneyRef, sku: ref, mode: oneOf("one_time", "subscription") });
const delivery = object({
  ...assignment, bucketKey: moneyRef, carrierRef: ref, serviceRef: ref, separatelyStated: boolean,
  cost: object({ ref, currency: ref, amountMinor: unsigned }),
});
const address = object({ line1: addressText, city: addressText, postalCode: addressText, countryCode: addressText },
  { line2: addressText, subdivisionCode: addressText });
const destination = object({ snapshotRef: ref, digest, policyRevision: ref, address });
const quoteFields = object({
  scope, market: ref, currency: ref, money, purpose: oneOf("final", "estimate"), taxDate: instant, destination,
  shipFromRef: ref, policyRevision: ref, classMapRevision: ref, lines: array(line, 256), delivery: array(delivery, 256),
  required: requiredCells, coverage,
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

function quote(value: unknown, field: string): TaxQuoteInputV1 {
  const parsed = quoteFields(value, field);
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
  return parsed;
}

const quoteRequest = object({ key: ref, inputDigest: digest, input: quote });
export const taxQuoteRequestV1Schema: Schema<TaxQuoteRequestV1> = schema(quoteRequest);
export const quoteInputSchema: Schema<TaxQuoteInputV1> = schema(quote);
export const parseQuoteKey = (key: unknown): string => ref(key, "/key");

const coverageRow = object({
  cell, decision: oneOf("undeclared", "in_scope_taxed", "in_scope_exempt", "out_of_scope", "inconsistent", "unavailable_evidence"),
}, { declaration, registration, treatment });
const coverageEvidence = object({ vector: array(coverageRow), digest });
const resolution = object({ assignmentRef: ref, policyRevision: ref, sourceRef: ref, effective: interval }, { sourceDigest: digest });
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
const evidenceFields = object({
  scope, calculationRef: ref, status: oneOf("final", "estimate"), calculatedAt: instant, expiresAt: instant, taxDate: instant,
  destinationDigest: digest, shipFromRef: ref, inputDigest: digest, policyRevision: ref, classMapRevision: ref,
  coverage: coverageEvidence, fiscalDigest: digest, positions: object({ tax: array(position), fees: array(fee) }),
});

function evidence(value: unknown, field: string, bindCells = true): TaxCalculationEvidenceV1 {
  const parsed = evidenceFields(value, field);
  if (parsed.calculatedAt >= parsed.expiresAt) invalid(field + "/expiresAt", "Supply an expiry after calculation.");
  const { vector } = parsed.coverage;
  vector.forEach((row, index) => {
    const path = field + "/coverage/vector/" + index;
    if (index > 0 && compareCells(vector[index - 1].cell, row.cell) >= 0) invalid(path, "Supply uniquely ordered coverage cells.");
    if (row.declaration && (declarationKey(row.declaration) !== declarationKey(row.cell)
      || !includesInstant(row.declaration.effective, parsed.taxDate))) invalid(path + "/declaration", "Supply the effective declaration for this cell.");
    if (row.registration && !includesInstant(row.registration.effective, parsed.taxDate)) {
      invalid(path + "/registration", "Supply the registration effective on the tax date.");
    }
    if ((parsed.status === "final" && !permitsAssessment("tax", row.decision, 0))
      || (permitsAssessment("tax", row.decision, 0) && !decisionIsPossible(row))) {
      invalid(path + "/decision", "Reconcile the named cell from effective observations.", "tax_calculation_unusable");
    }
  });
  unique(parsed.positions.tax, item => item.positionRef, field + "/positions/tax", "tax_breakdown_incomplete");
  unique(parsed.positions.fees, item => item.feeKey, field + "/positions/fees", "tax_breakdown_incomplete");
  const cells = new Map(vector.map(row => [cellKey(row.cell), row]));
  parsed.positions.tax.forEach((item, index) => {
    const bound = cells.get(cellKey(item.cell));
    const path = field + "/positions/tax/" + index;
    if (bindCells && (!bound || item.cell.target.kind === "fee" || !sameCell(bound.cell, item.cell)
      || !permitsAssessment("tax", bound.decision, 0))) invalid(path + "/cell", "Bind the position to a resolved tax cell.");
    if (!includesInstant(item.resolution.effective, parsed.taxDate)) {
      invalid(path + "/resolution/effective", "Supply a rule resolution effective on the tax date.");
    }
  });
  if (bindCells) parsed.positions.fees.forEach((item, index) => {
    const key = JSON.stringify(["fee", item.feeKey, item.jurisdiction, item.feeKind]);
    const bound = cells.get(key);
    if (bound?.cell.target.kind !== "fee" || !permitsAssessment("fee", bound.decision, 0)
      || bound.cell.target.deliveryKey !== (item.scope.kind === "delivery" ? item.scope.key : undefined)) {
      invalid(field + "/positions/fees/" + index, "Bind the fee to the matching in-scope fee cell.");
    }
  });
  return parsed;
}
export const taxCalculationEvidenceV1Schema: Schema<TaxCalculationEvidenceV1> = schema(evidence);
// The Node quote verifier joins these rows with money before checking their cell bindings.
export const quoteEvidenceSchema: Schema<TaxCalculationEvidenceV1> = schema((value, field) => evidence(value, field, false));

const validityFields = object({ original: quoteRequest, evidence, evidenceDigest: digest, chargeAt: instant, current: quote });
export const taxFiscalValidityRequestV1Schema: Schema<TaxFiscalValidityRequestV1> = schema((value, field) => {
  const parsed = validityFields(value, field);
  if (parsed.current.taxDate !== parsed.chargeAt) invalid("/current/taxDate", "Use the charge instant as the current fiscal date.");
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
