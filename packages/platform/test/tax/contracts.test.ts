import { describe, expect, it } from "vitest";
import { makeTaxQuoteRequest, reconcileTaxCoverage } from "../../src/tax/index.js";
import {
  taxCalculationEvidenceV1Schema, taxCloseInputV1Schema, taxCommitRequestV1Schema, taxCoverageV1Schema,
  taxFiscalValidityRequestV1Schema, taxQuoteRequestV1Schema, taxReverseRequestV1Schema,
} from "../../src/tax/contracts/index.js";
import type { TaxCalculationEvidenceV1 } from "../../src/tax/contracts/index.js";
import { active, cell, coverage, date, digest, later, quote, registered, scope, taxable } from "./fixtures.js";

function refuses(run: () => unknown, field: string): void {
  expect(run).toThrow(expect.objectContaining({ field }));
}

describe("tax document decoders", () => {
  it("rejects nested unknown keys, accessors, symbols and nonplain shapes without reading data", () => {
    const input = quote();
    const request = makeTaxQuoteRequest("key", input);
    let read = false;
    const address = { ...input.destination.address, get line1() { read = true; return "private"; } };
    const replacement = (value: unknown) => ({ ...request, input: { ...input, destination: { ...input.destination, address: value } } });

    refuses(() => taxQuoteRequestV1Schema.parse(replacement(address)), "/input/destination/address/line1");
    expect(read).toBe(false);
    const unknown = taxQuoteRequestV1Schema.safeParse(replacement({ ...input.destination.address, secret: "private" }));
    expect(unknown).toMatchObject({ success: false, error: { field: "/input/destination/address" } });
    if (!unknown.success) expect(unknown.error.message).not.toContain("private");
    refuses(() => taxQuoteRequestV1Schema.parse(replacement({ ...input.destination.address, [Symbol()]: "ignored" })), "/input/destination/address");
    refuses(() => taxQuoteRequestV1Schema.parse(replacement(new Date())), "/input/destination/address");
    refuses(() => taxQuoteRequestV1Schema.parse(replacement({ ...input.destination.address, line2: null })), "/input/destination/address/line2");
    refuses(() => taxQuoteRequestV1Schema.parse({ ...request, input: { ...input, required: Array(2) } }), "/input/required");
    expect(taxQuoteRequestV1Schema.parse(request).input.destination.address).not.toHaveProperty("line2");
    expect(taxQuoteRequestV1Schema.parse(request).input).not.toBe(request.input);
  });

  it("rejects invalid instants, bad variants and overlapping declarations", () => {
    const entry = registered();
    const first = { ...entry, effective: { from: date, until: later } };
    expect(taxCoverageV1Schema.parse(coverage({ ...entry, effective: { from: later } }, first))).toBeTruthy();
    refuses(() => taxCoverageV1Schema.parse(coverage(first, entry)), "/declarations/1/effective");
    refuses(() => taxCoverageV1Schema.parse(coverage({ ...entry, effective: { from: date, until: date } })), "/declarations/0/effective/until");
    refuses(() => taxCoverageV1Schema.parse(coverage({ ...entry, recordedAt: "2030-02-31T00:00:00.000Z" })), "/declarations/0/recordedAt");
    refuses(() => taxCoverageV1Schema.parse({ ...coverage(), declarations: [{ ...entry, status: "unknown" }] }), "/declarations/0/status");
    refuses(() => taxCoverageV1Schema.parse({ ...coverage(), declarations: [{ ...entry, acknowledgementRef: "unexpected" }] }), "/declarations/0");
  });

  it("validates safe arithmetic, money-linked facts, complete cells and rule-owned fees", () => {
    const input = quote();
    const { sources } = input.money;
    const badMoneyInputs = [
      [{ ...input.money, sources: [{ ...sources[0], unitBasisMinor: Number.MAX_SAFE_INTEGER, quantity: 2 }, sources[1]] }, "/money/sources/0"],
      [{ ...input.money, fees: [{ feeKey: "fee-a", amountMinor: 2 }] }, "/money/fees"],
      [{ ...input.money, adjustments: [{ ...input.money.adjustments[0], target: { lineKeys: ["unknown"] } }] }, "/money/adjustments/0/target/lineKeys/0"],
    ] as const;
    for (const [money, field] of badMoneyInputs) refuses(() => makeTaxQuoteRequest("key", { ...input, money }), field);
    refuses(() => makeTaxQuoteRequest("key", { ...input, lines: input.lines.slice(1) }), "/lines");
    refuses(() => makeTaxQuoteRequest("key", { ...input, required: input.required.filter(row => row.target.kind !== "delivery") }), "/required");
    refuses(() => makeTaxQuoteRequest("key", { ...input, required: [...input.required, cell("unknown")] }), "/required/4/target");
    refuses(() => makeTaxQuoteRequest("", input), "/key");
  });

  it("pins a tagged request digest and normalizes only the required cells and declarations", () => {
    const input = quote();
    const request = makeTaxQuoteRequest("key", input);
    expect(request.inputDigest).toBe("b661bc4d7148712db7c1006eb630ec07ac54721bd3e17678c360558f64620f1a");
    expect(makeTaxQuoteRequest("other-key", {
      ...input, required: [...input.required].reverse(),
      coverage: { ...input.coverage, declarations: [...input.coverage.declarations].reverse() },
    }).inputDigest).toBe(request.inputDigest);
    expect(makeTaxQuoteRequest("key", { ...input, money: { ...input.money, sources: [...input.money.sources].reverse() } }).inputDigest)
      .not.toBe(request.inputDigest);
    expect(makeTaxQuoteRequest("key", {
      ...input, destination: { ...input.destination, address: { ...input.destination.address, line2: "Suite A" } },
    }).inputDigest).not.toBe(request.inputDigest);
    expect(makeTaxQuoteRequest("key", { ...input, destination: { ...input.destination, digest: "b".repeat(64) } }).inputDigest)
      .not.toBe(request.inputDigest);
  });

  const input = quote();
  const request = makeTaxQuoteRequest("key", {
    ...input, coverage: coverage(...input.coverage.declarations, { ...registered(), taxKind: "fee-a" }),
  });
  const { vector, digest: coverageDigest } = reconcileTaxCoverage({
    scope, taxDate: date, coverage: request.input.coverage, required: input.required,
    observations: input.required.map(cell => ({ cell, registration: active, treatment: taxable, assessedMinor: 0 })),
  });
  const receipt: TaxCalculationEvidenceV1 = {
    scope, calculationRef: "calculation-a", status: "final", calculatedAt: date, expiresAt: later,
    taxDate: date, destinationDigest: digest, shipFromRef: request.input.shipFromRef, inputDigest: request.inputDigest,
    policyRevision: request.input.policyRevision, classMapRevision: request.input.classMapRevision,
    coverage: { vector, digest: coverageDigest }, fiscalDigest: digest,
    positions: { fees: [], tax: [{
      positionRef: "position-a", cell: cell(), ratePercent: "8.125000", taxabilityReason: "standard", ruleRef: "rule-a",
      resolution: { assignmentRef: "assignment-a", policyRevision: "policy-a", sourceRef: "table-a", effective: { from: date } },
      resolutionDigest: digest,
    }] },
  };

  it("validates evidence bindings, clock bounds and the shared rate grammar", () => {
    expect(taxCalculationEvidenceV1Schema.parse(receipt)).toEqual(receipt);
    const tax = receipt.positions.tax[0];
    refuses(() => taxCalculationEvidenceV1Schema.parse({ ...receipt, expiresAt: date }), "/expiresAt");
    refuses(() => taxCalculationEvidenceV1Schema.parse({
      ...receipt, coverage: { ...receipt.coverage, vector: [{ cell: cell(), decision: "in_scope_taxed" }] },
    }), "/coverage/vector/0/decision");
    refuses(() => taxCalculationEvidenceV1Schema.parse({ ...receipt, positions: { fees: [], tax: [tax, tax] } }), "/positions/tax/1");
    for (const ratePercent of ["1.1234567", "9007199254.740992", "1e-3"]) {
      refuses(() => taxCalculationEvidenceV1Schema.parse({ ...receipt, positions: { fees: [], tax: [{ ...tax, ratePercent }] } }),
        "/positions/tax/0/ratePercent");
    }
    const fiscal = { original: request, current: { ...request.input, taxDate: later }, evidence: receipt, evidenceDigest: digest, chargeAt: later };
    expect(taxFiscalValidityRequestV1Schema.parse(fiscal)).toEqual(fiscal);
    refuses(() => taxFiscalValidityRequestV1Schema.parse({ ...fiscal, chargeAt: date }), "/current/taxDate");
    refuses(() => taxFiscalValidityRequestV1Schema.parse({ ...fiscal, evidence: { ...receipt, inputDigest: digest } }), "/evidence/inputDigest");
    const incomplete = { ...receipt, coverage: { ...receipt.coverage, vector: [vector.at(-1)!] } };
    refuses(() => taxFiscalValidityRequestV1Schema.parse({ ...fiscal, evidence: incomplete }), "/evidence/coverage/vector");
    const wrongAssignment = { ...tax, resolution: { ...tax.resolution, assignmentRef: "unknown" } };
    refuses(() => taxFiscalValidityRequestV1Schema.parse({
      ...fiscal, evidence: { ...receipt, positions: { tax: [wrongAssignment], fees: [] } },
    }), "/evidence/positions/tax/0/resolution/assignmentRef");
  });

  it("validates close, commit and reversal envelopes", () => {
    const ref = { scope, ref: "calculation-a", evidenceDigest: digest };
    const close = { ref, reason: { kind: "verified_unpaid", evidenceRef: "payment-a" }, key: "close-a" };
    expect(taxCloseInputV1Schema.parse(close)).toEqual(close);
    refuses(() => taxCloseInputV1Schema.parse({ ...close, reason: { ...close.reason, kind: "unknown" } }), "/reason/kind");
    const commit = { calculationRef: ref, transactionRef: "sale-a", postedAt: later, capturedAt: date, captureEvidenceRef: "capture-a", intent: "recover" };
    expect(taxCommitRequestV1Schema.parse(commit)).toEqual(commit);
    refuses(() => taxCommitRequestV1Schema.parse({ ...commit, postedAt: date, capturedAt: later }), "/postedAt");

    const reverse = {
      scope, originalRef: "sale-a", reversalRef: "refund-a", refundEvidenceRef: "verified-a", currency: "XXX",
      fromMinor: 40, toMinor: 100, intent: "apply", mode: "amount", amountMinor: 60,
      positions: [{ originalPositionRef: "position-a", netDeltaMinor: -50, taxDeltaMinor: -9, feeDeltaMinor: -1 }],
      feeEvidenceRef: "fee-rule-a",
    };
    expect(taxReverseRequestV1Schema.parse(reverse)).toEqual(reverse);
    refuses(() => taxReverseRequestV1Schema.parse({ ...reverse, amountMinor: 100 }), "/amountMinor");
    refuses(() => taxReverseRequestV1Schema.parse({ ...reverse, toMinor: 40 }), "/toMinor");
    refuses(() => taxReverseRequestV1Schema.parse({ ...reverse, mode: "full" }), "");
    const { feeEvidenceRef: _feeEvidence, ...noFeeEvidence } = reverse;
    refuses(() => taxReverseRequestV1Schema.parse(noFeeEvidence), "/feeEvidenceRef");
  });
});
