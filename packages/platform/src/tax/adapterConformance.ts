import { isDeepStrictEqual } from "node:util";
import { TAX_CALCULATION_CONTRACT_VERSION } from "./contracts/index.js";
import type {
  TaxCalculationPort, TaxCalculationRefV1, TaxCommitRequestV1, TaxQuoteInputV1, TaxQuoteRequestV1,
  TaxQuoteResultV1, TaxRefusal, TaxReverseRequestV1,
} from "./contracts/index.js";
import { cellKey, compareCells } from "./contracts/identity.js";
import { instant } from "./contracts/schemas.js";
import { makeTaxQuoteRequest, taxDigest, taxFiscalDigest, verifyTaxQuoteResult } from "./digest.js";

const cases = [
  "missing_class", "missing_rule", "tax_coverage_undeclared_refuses", "exempt_in_scope", "out_of_scope", "mixed_coverage",
  "inconsistent_coverage_refuses_charge", "fee_on_free_delivery", "rate_change", "expiry", "foreign_validity_scope",
  "local_close", "reference_conflict", "unavailable", "duplicate_commit", "partial_then_full",
] as const;

export type TaxConformanceCaseV1 = typeof cases[number];

export interface TaxConformanceSubjectV1 {
  /**
   * Open an isolated offline fixture. Clock cases supply the next charge instant and current input through advance.
   * The fee fixture uses a free delivery bucket and a 25-minor-unit fee with refund rule ref "refund-a", revision "1".
   * Posting fixtures use one taxable position on 100 minor units with zero tax and no fee, fully eligible for reversal.
   * Positive reversal scenarios use declared modes. The partial-then-full scenario uses lines or amount together with full.
   * Report cumulative side effect counts, including unsuccessful calls that dispatched an effect.
   */
  open(caseId: TaxConformanceCaseV1): Promise<{
    port: TaxCalculationPort;
    request: TaxQuoteRequestV1;
    advance?: () => { chargeAt: string; current: TaxQuoteInputV1 };
    effects: () => { commits: number; reversals: number; providerCloses: number };
  }>;
}

type Fixture = Awaited<ReturnType<TaxConformanceSubjectV1["open"]>>;
type Final = Extract<TaxQuoteResultV1, { kind: "final" }>;
type Result = Awaited<ReturnType<TaxCalculationPort["commit" | "reverse"]>>;
type Assert = (condition: unknown, expected: string) => asserts condition;

const refusals = {
  missing_class: "tax_class_missing",
  missing_rule: "tax_rule_missing",
  tax_coverage_undeclared_refuses: "tax_coverage_undeclared",
  inconsistent_coverage_refuses_charge: "tax_coverage_inconsistent",
} as const;

function checkEffects(assert: Assert, fixture: Fixture, commits = 0, reversals = 0) {
  assert(isDeepStrictEqual(fixture.effects(), { commits, reversals, providerCloses: 0 }),
    `exact effect counts (${commits} commits, ${reversals} reversals, zero provider closes)`);
}

function checkRefusal(assert: Assert, result: Result, code: TaxRefusal["code"]) {
  assert(result.kind === "refused" && result.code === code, "refusal " + code);
  if (code === "tax_reference_conflict") assert(!Object.hasOwn(result, "expected"), "integrity refusal supplies no repair value");
}

function checkRejectedCoverage(assert: Assert, request: TaxQuoteRequestV1, result: TaxQuoteResultV1) {
  if (result.kind !== "refused") return;
  const expected = result.code === "tax_coverage_undeclared" ? "undeclared" : "inconsistent";
  const row = result.coverage?.vector.find(row => row.decision === expected);
  assert(row && row.cell.jurisdiction === result.jurisdiction && row.cell.taxKind === result.taxKind,
    "refusal names the first rejected jurisdiction and tax kind");
  assert(result.coverage?.digest === taxDigest("coverage", result.coverage?.vector), "canonical refusal coverage digest");
  assert(isDeepStrictEqual(result.coverage.vector.map(row => row.cell), [...request.input.required].sort(compareCells)),
    "complete refusal coverage vector");
}

function calculationRef(result: Final): TaxCalculationRefV1 {
  return { scope: result.evidence.scope, ref: result.evidence.calculationRef, evidenceDigest: result.evidenceDigest };
}

function checkInstant(assert: Assert, value: unknown, field: string) {
  try { instant(value, field); }
  catch { assert(false, "canonical UTC instant at " + field); }
}

async function checkValidity(assert: Assert, caseId: TaxConformanceCaseV1, fixture: Fixture, final: Final) {
  assert(fixture.advance, "advance control for fiscal validity");
  const current = fixture.advance();
  const { chargeAt } = current;
  checkInstant(assert, chargeAt, "/chargeAt");
  const { evidence, evidenceDigest } = final;
  const proof = await fixture.port.readFiscalValidity({ ...current, original: fixture.request, evidence, evidenceDigest });
  if (proof.kind !== "unavailable") {
    const { observedAt, effective, dispatchBefore } = proof.proof;
    checkInstant(assert, observedAt, "/proof/observedAt");
    checkInstant(assert, effective?.from, "/proof/effective/from");
    if (effective.until !== undefined) checkInstant(assert, effective.until, "/proof/effective/until");
    checkInstant(assert, dispatchBefore, "/proof/dispatchBefore");
  }
  if (caseId === "foreign_validity_scope") {
    assert(!isDeepStrictEqual(current.current.scope, fixture.request.input.scope), "fixture uses another scope");
    assert(proof.kind === "unavailable" && proof.code === "tax_fiscal_validity_unavailable" && proof.effect === "none",
      "another scope returns fiscal validity unavailable without effects");
    return;
  }
  if (fixture.port.capabilities().validity !== "read_only") {
    assert(proof.kind === "unavailable" && proof.effect === "none", "unsupported read-only validity has no effect");
    return;
  }
  const changed = caseId === "rate_change";
  assert(changed ? chargeAt < evidence.expiresAt : chargeAt >= evidence.expiresAt,
    changed ? "fixture changes rates before expiry" : "fixture advances past calculation expiry");
  assert(proof.kind === (changed ? "changed" : "unchanged"), "fiscal validity distinguishes rate change from calculation expiry");
  const { proof: data } = proof;
  assert(data.evidenceDigest === evidenceDigest && data.calculationRef === evidence.calculationRef, "proof binds original evidence");
  assert(data.observedAt < data.dispatchBefore && data.effective.from <= chargeAt && chargeAt < data.dispatchBefore
    && (data.effective.until === undefined || data.dispatchBefore <= data.effective.until), "bounded charge-date dispatch deadline");
  if (!changed) {
    assert(data.fiscalDigest === evidence.fiscalDigest, "unchanged validity preserves the fiscal digest");
    return;
  }

  const key = fixture.request.key === "rate-change-current" ? "rate-change-follow-up" : "rate-change-current";
  const currentRequest = makeTaxQuoteRequest(key, current.current);
  const currentQuote = await fixture.port.quote(currentRequest);
  assert(currentQuote.kind === "final" && !verifyTaxQuoteResult(currentRequest, currentQuote), "verifiable current rate-change quote");
  const currentDigest = taxFiscalDigest(currentQuote.evidence);
  assert(currentDigest !== evidence.fiscalDigest, "rate-change fixture changes the fiscal digest");
  assert(data.fiscalDigest === currentDigest, "changed proof carries the current fiscal digest");
}

async function checkPosting(assert: Assert, caseId: TaxConformanceCaseV1, fixture: Fixture, final: Final) {
  const { port, request } = fixture;
  const { posting, reversals, recovery } = port.capabilities();
  const partialMode = reversals.includes("lines") ? "lines" : reversals.includes("amount") ? "amount" : undefined;
  if (posting === "provider" && caseId === "partial_then_full" && !(partialMode && reversals.includes("full"))) return;
  const commit: TaxCommitRequestV1 = { calculationRef: calculationRef(final), transactionRef: "sale-a",
    capturedAt: final.evidence.calculatedAt, postedAt: final.evidence.calculatedAt, captureEvidenceRef: "capture-a", intent: "apply" };
  const [position] = final.evidence.positions.tax;
  assert(final.evidence.positions.tax.length === 1 && final.money.payableMinor === 100
    && final.money.netTotal === 100, "posting fixture has a single fully refundable 100-minor-unit position");
  const originalPositionRef = position.providerLineRef ?? position.positionRef;
  function reversal(originalRef: string, fromMinor: number, toMinor: number, mode: TaxReverseRequestV1["mode"]): TaxReverseRequestV1 {
    const requestFields = { originalRef, scope: request.input.scope, currency: request.input.currency, fromMinor, toMinor,
      reversalRef: "reversal-" + fromMinor, refundEvidenceRef: "refund-" + toMinor, intent: "apply" as const,
      positions: [{ originalPositionRef, netDeltaMinor: fromMinor - toMinor, taxDeltaMinor: 0, feeDeltaMinor: 0 }] };
    return mode === "amount" ? { ...requestFields, mode, amountMinor: toMinor - fromMinor } : { ...requestFields, mode };
  }
  const conflictingCommit = { ...commit, captureEvidenceRef: "capture-b" };
  const posted = await port.commit(commit);
  if (posting === "unsupported") {
    assert(!reversals.length && !recovery.length, "unsupported posting has no reversal or recovery capabilities");
    checkRefusal(assert, posted, "tax_operation_unsupported");
    checkRefusal(assert, await port.commit({ ...commit, intent: "recover" }), "tax_operation_unsupported");
    checkRefusal(assert, await port.commit(caseId === "reference_conflict" ? conflictingCommit : commit), "tax_operation_unsupported");
    if (caseId !== "duplicate_commit") {
      const partial = reversal("sale-a", 0, 40, "amount");
      checkRefusal(assert, await port.reverse(partial), "tax_operation_unsupported");
      checkRefusal(assert, await port.reverse({ ...partial, intent: "recover" }), "tax_operation_unsupported");
      checkRefusal(assert, await port.reverse(caseId === "reference_conflict" ? { ...partial, refundEvidenceRef: "refund-b" }
        : reversal("sale-a", 40, 100, "full")), "tax_operation_unsupported");
    }
    checkEffects(assert, fixture);
    return;
  }

  assert(posted.kind === "committed" && posted.providerTransactionRef.length > 0 && posted.positions.length === 1
    && posted.positions[0].originalPositionRef === originalPositionRef && posted.positions[0].postedPositionRef.length > 0,
  "posting returns the original-to-posted position mapping");
  checkEffects(assert, fixture, 1);
  if (caseId !== "partial_then_full") {
    assert(isDeepStrictEqual(await port.commit(commit), posted), "duplicate commit preserves the transaction and position mapping");
    checkEffects(assert, fixture, 1);
    checkRefusal(assert, await port.commit(conflictingCommit), "tax_reference_conflict");
    checkEffects(assert, fixture, 1);
  }
  if (caseId === "duplicate_commit") return;

  if (caseId === "reference_conflict") {
    const mode = reversals.includes("amount") ? "amount" : reversals[0];
    if (!mode) return;
    const original = reversal(posted.providerTransactionRef, 0, mode === "amount" ? 40 : 100, mode);
    const reversed = await port.reverse(original);
    assert(reversed.kind === "reversed" && reversed.providerReversalRef.length > 0
      && isDeepStrictEqual(reversed.positions, original.positions), "reversal returns the reserved deltas");
    checkEffects(assert, fixture, 1, 1);
    checkRefusal(assert, await port.reverse({ ...original, refundEvidenceRef: "refund-b" }), "tax_reference_conflict");
    checkEffects(assert, fixture, 1, 1);
    return;
  }

  const partial = reversal(posted.providerTransactionRef, 0, 40, partialMode!);
  const first = await port.reverse(partial);
  assert(first.kind === "reversed" && first.providerReversalRef.length > 0
    && isDeepStrictEqual(first.positions, partial.positions), "partial reversal returns exactly the reserved 40");
  checkEffects(assert, fixture, 1, 1);
  const remainder = reversal(posted.providerTransactionRef, 40, 100, "full");
  const second = await port.reverse(remainder);
  assert(second.kind === "reversed" && second.providerReversalRef.length > 0 && second.providerReversalRef !== first.providerReversalRef
    && isDeepStrictEqual(second.positions, remainder.positions), "full reversal returns exactly the remaining 60 under a distinct reference");
  assert(isDeepStrictEqual(await port.reverse(partial), first) && isDeepStrictEqual(await port.reverse(remainder), second),
    "both reversal reservations replay exactly");
  checkEffects(assert, fixture, 1, 2);
}

function checkCoverageAndMoney(assert: Assert, caseId: TaxConformanceCaseV1, final: Final) {
  const { money, evidence } = final;
  const { vector } = evidence.coverage;
  const decisions = vector.map(row => row.decision);
  switch (caseId) {
    case "exempt_in_scope":
      assert(vector.some(row => row.decision === "in_scope_exempt" && row.treatment?.kind === "exempt")
        && decisions.includes("in_scope_taxed") && money.taxTotal === 0
        && money.components.some(component => component.final.taxPositions.some(position => position.taxMinor === 0
          && evidence.positions.tax.some(row => row.positionRef === position.positionRef
            && vector.some(covered => cellKey(covered.cell) === cellKey(row.cell) && covered.decision === "in_scope_taxed")))),
      "explicit exemption and zero-rounded taxable position both remain in scope");
      break;
    case "out_of_scope":
      assert(decisions.length > 0 && decisions.every(decision => decision === "out_of_scope")
        && money.taxTotal === 0 && money.feeTotal === 0, "only out-of-scope cells and no assessments");
      break;
    case "mixed_coverage":
      assert(decisions.includes("out_of_scope") && decisions.some(decision => decision === "in_scope_taxed" || decision === "in_scope_exempt"),
        "coverage preserves both out-of-scope and reportable cells");
      break;
    case "fee_on_free_delivery": {
      const [fee] = evidence.positions.fees;
      assert(money.fees.length === 1 && money.fees[0].feeKey === fee?.feeKey && money.feeTotal === 25
        && money.payableMinor - money.netTotal - money.taxTotal === 25, "exactly one fee adds 25 to payable");
      const { scope, refundRule } = fee;
      assert(scope.kind === "delivery" && money.components.some(({ ref, final }) =>
        ref.kind === "delivery" && ref.bucketKey === scope.key && final.netMinor === 0)
        && refundRule.ref === "refund-a" && refundRule.revision === "1", "fee is pinned to free delivery and the refund rule");
      break;
    }
  }
}

/** Run isolated synthetic scenarios and throw a case-specific error on the first broken guarantee. */
export async function runTaxAdapterConformance(subject: TaxConformanceSubjectV1): Promise<readonly TaxConformanceCaseV1[]> {
  for (const caseId of cases) {
    const assert: Assert = (condition, expected) => {
      if (!condition) throw new Error(`tax_adapter_conformance:${caseId}: expected ${expected}`);
    };
    const fixture = await subject.open(caseId);
    const { port, request } = fixture;
    assert(port.contractVersion === TAX_CALCULATION_CONTRACT_VERSION
      && isDeepStrictEqual(port.capabilities().bases, ["exclusive"]), "exclusive tax contract capabilities");
    checkEffects(assert, fixture);
    const result = await port.quote(request);
    if (result.kind === "final" || result.kind === "estimate") {
      checkInstant(assert, result.evidence?.calculatedAt, "/evidence/calculatedAt");
      checkInstant(assert, result.evidence?.expiresAt, "/evidence/expiresAt");
      assert(!verifyTaxQuoteResult(request, result), "verifiable quote money and evidence");
    } else {
      // The verifier allows a refusal envelope. It must carry no verifiable calculation.
      assert(!("money" in result) && !("evidence" in result) && !("evidenceDigest" in result), "refusal or outage has no calculation");
    }
    if (caseId in refusals) {
      assert(result.kind === "refused" && result.code === refusals[caseId as keyof typeof refusals], "expected quote refusal");
      if (caseId !== "missing_class" && caseId !== "missing_rule") checkRejectedCoverage(assert, request, result);
    } else if (caseId === "unavailable") {
      assert(result.kind === "unavailable" && result.effect === "none", "retryable outage before any effect");
    } else {
      assert(result.kind === "final", "final quote for this fixture");
      if (caseId === "reference_conflict" || caseId === "duplicate_commit" || caseId === "partial_then_full") {
        checkEffects(assert, fixture);
        await checkPosting(assert, caseId, fixture, result);
        continue;
      }
      if (caseId === "rate_change" || caseId === "expiry" || caseId === "foreign_validity_scope") {
        await checkValidity(assert, caseId, fixture, result);
      } else if (caseId === "local_close") {
        const ref = calculationRef(result), key = "close-a";
        const reason = { kind: "affirmatively_unused", evidenceRef: "unused-a" } as const;
        const closed = await port.closeCalculation(ref, reason, key);
        assert(isDeepStrictEqual(closed, { kind: "closed", ref, key })
          && isDeepStrictEqual(await port.closeCalculation(ref, reason, key), closed), "close receipt and exact replay");
      } else checkCoverageAndMoney(assert, caseId, result);
    }
    checkEffects(assert, fixture);
  }
  return [...cases];
}
