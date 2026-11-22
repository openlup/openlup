import { createHash } from "node:crypto";
import { calculateCatalogueMoneyV2, planCatalogueMoneyV2 } from "@openlup/core/pricing";
import { describe, expect, it } from "vitest";
import { canonicalCatalogDraftJson } from "../../src/catalog/contracts/index.js";
import { makeTaxQuoteRequest, reconcileTaxCoverage, verifyTaxQuoteRequest, verifyTaxQuoteResult } from "../../src/tax/index.js";
import {
  taxCalculationEvidenceV1Schema, taxCloseInputV1Schema, taxCommitRequestV1Schema, taxCoverageV1Schema,
  taxFiscalValidityRequestV1Schema, taxQuoteRequestV1Schema, taxReverseRequestV1Schema,
} from "../../src/tax/contracts/index.js";
import type { TaxCalculationEvidenceV1, TaxQuoteResultV1 } from "../../src/tax/contracts/index.js";
import { active, cell, coverage, date, digest, later, quote, registered, scope, taxable } from "./fixtures.js";

function refuses(run: () => unknown, field: string): void {
  expect(run).toThrow(expect.objectContaining({ field }));
}

function taggedDigest(tag: "coverage" | "evidence", value: unknown): string {
  return createHash("sha256").update(canonicalCatalogDraftJson(["platform.tax." + tag + ".v1", value])).digest("hex");
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

  it("refuses an unsafe planned basis in preparation and decoding", () => {
    const input = quote();
    const money = {
      ...input.money, adjustments: [],
      sources: input.money.sources.map((row, i) => ({ ...row, unitBasisMinor: i ? 0 : Number.MAX_SAFE_INTEGER })),
      delivery: [{ ...input.money.delivery[0], amountMinor: 1 }],
    };
    const unsafe = { ...input, money };
    expect(() => makeTaxQuoteRequest("key", unsafe)).toThrow(expect.objectContaining({
      code: "tax_amount_out_of_range", field: "/money",
    }));
    const envelope = { key: "key", input: unsafe, inputDigest: digest };
    expect(taxQuoteRequestV1Schema.safeParse(envelope)).toMatchObject({
      success: false, error: { code: "tax_amount_out_of_range", field: "/input/money" },
    });
    expect(verifyTaxQuoteRequest(envelope)).toMatchObject({ code: "tax_amount_out_of_range", field: "/input/money" });
    const safe = { ...money, adjustments: [{ adjustmentRef: "discount", sequence: 1, amountMinor: 1, target: { lineKeys: ["item-z"] } }] };
    expect(() => makeTaxQuoteRequest("key", { ...input, money: safe })).not.toThrow();
  });

  it("pins a tagged request digest and normalizes only the required cells and declarations", () => {
    const input = quote();
    const request = makeTaxQuoteRequest("key", input);
    expect(verifyTaxQuoteRequest(request)).toBeUndefined();
    const altered = taxQuoteRequestV1Schema.parse({ ...request, input: { ...input, currency: "XTS" } });
    expect(verifyTaxQuoteRequest(altered)).toMatchObject({
      kind: "refused", code: "tax_reference_conflict", field: "/inputDigest", remedy: expect.stringContaining("new key"),
    });
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
    positions: { fees: [{
      feeKey: "fee-a", jurisdiction: "district-a", feeKind: "fee-a", scope: { kind: "delivery", key: "shipping-a" },
      refundRule: { ref: "fee-rule", revision: "revision-a" },
    }], tax: [{
      positionRef: "position-a", cell: cell(), ratePercent: "8.125000", taxabilityReason: "standard", ruleRef: "rule-a",
      resolution: { assignmentRef: "assignment-a", policyRevision: "policy-a", sourceRef: "table-a", effective: { from: date } },
      resolutionDigest: digest,
    }] },
  };

  const money = calculateCatalogueMoneyV2({ ...request.input.money, fees: [{ feeKey: "fee-a", amountMinor: 5 }] }, {
    kind: "local",
    components: planCatalogueMoneyV2(request.input.money).components.map(({ ref }) => ({
      ref, rates: ref.kind === "merchandise" && ref.lineKey === "item-z"
        ? [{ positionRef: "position-a", jurisdictionRef: "district-a", rateDecimal: "8.125" }] : [],
    })),
  });
  const successful = (evidence = receipt) => ({
    kind: "final" as const, money, evidence: { ...evidence, status: "final" as const }, evidenceDigest: taggedDigest("evidence", evidence),
  });
  const fiscal = {
    original: request, current: { ...request.input, taxDate: later }, evidence: receipt,
    evidenceDigest: taggedDigest("evidence", receipt), chargeAt: later,
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
    expect(taxFiscalValidityRequestV1Schema.parse(fiscal)).toEqual(fiscal);
    refuses(() => taxFiscalValidityRequestV1Schema.parse({ ...fiscal, chargeAt: date }), "/current/taxDate");
  });

  it("verifies the original digest and evidence for fiscal validity through the shared verifier", () => {
    const verify = (evidence: TaxCalculationEvidenceV1, original = request) =>
      verifyTaxQuoteRequest(taxFiscalValidityRequestV1Schema.parse({
        ...fiscal, original, evidence, evidenceDigest: taggedDigest("evidence", evidence),
      }));
    expect(verifyTaxQuoteRequest(fiscal)).toBeUndefined();
    expect(verifyTaxQuoteRequest({ ...fiscal, evidenceDigest: digest })).toMatchObject({
      code: "tax_reference_conflict", field: "/evidenceDigest",
    });
    expect(verify(receipt, { ...request, input: { ...request.input, currency: "XTS" } })).toMatchObject({
      code: "tax_reference_conflict", field: "/original/inputDigest",
    });
    expect(verify({ ...receipt, inputDigest: digest })).toMatchObject({
      code: "tax_reference_conflict", field: "/evidence/inputDigest",
    });
    expect(verify({ ...receipt, coverage: { ...receipt.coverage, digest } })).toMatchObject({
      code: "tax_reference_conflict", field: "/evidence/coverage/digest",
    });
    const undeclared = makeTaxQuoteRequest("other-key", { ...request.input, coverage: coverage() });
    expect(verify({ ...receipt, inputDigest: undeclared.inputDigest }, undeclared)).toMatchObject({
      code: "tax_reference_conflict", field: "/evidence/coverage/vector/0/declaration",
    });
    const incomplete = vector.filter(row => row.cell.target.key !== "item-a");
    expect(verify({ ...receipt, coverage: { vector: incomplete, digest: taggedDigest("coverage", incomplete) } })).toMatchObject({
      code: "tax_reference_conflict", field: "/evidence/coverage/vector",
    });
    const tax = receipt.positions.tax[0];
    const wrongAssignment = { ...tax, resolution: { ...tax.resolution, assignmentRef: "unknown" } };
    expect(verify({ ...receipt, positions: { ...receipt.positions, tax: [wrongAssignment] } })).toMatchObject({
      code: "tax_reference_conflict", field: "/evidence/positions/tax/0/resolution/assignmentRef",
    });
  });

  it("verifies successful quote digests, status and request bindings", () => {
    const result = successful();
    expect(verifyTaxQuoteResult(request, result)).toBeUndefined();
    const estimateRequest = makeTaxQuoteRequest("estimate", { ...request.input, purpose: "estimate" });
    const estimate = { ...receipt, status: "estimate" as const, inputDigest: estimateRequest.inputDigest };
    expect(verifyTaxQuoteResult(estimateRequest, {
      kind: "estimate", money, evidence: estimate, evidenceDigest: taggedDigest("evidence", estimate),
    })).toBeUndefined();
    expect(verifyTaxQuoteResult(request, { ...result, evidence: estimate } as unknown as TaxQuoteResultV1)).toMatchObject({
      code: "tax_calculation_unusable", field: "/evidence/status",
    });
    expect(verifyTaxQuoteResult(request, { ...result, evidenceDigest: digest })).toMatchObject({
      code: "tax_reference_conflict", field: "/evidenceDigest",
    });
    const forgedDeclarations = vector.map(row => row.declaration
      ? { ...row, declaration: { ...row.declaration, actorRef: "different-actor" } } : row);
    for (const [rebound, field] of [
      [{ ...receipt, scope: { ...scope, accountRef: "other" } }, "/evidence/scope"],
      [{ ...receipt, destinationDigest: "b".repeat(64) }, "/evidence/destinationDigest"],
      [{ ...receipt, inputDigest: "b".repeat(64) }, "/evidence/inputDigest"],
      [{ ...receipt, coverage: { ...receipt.coverage, digest } }, "/evidence/coverage/digest"],
      [{ ...receipt, coverage: { vector: forgedDeclarations, digest: taggedDigest("coverage", forgedDeclarations) } },
        "/evidence/coverage/vector/0/declaration"],
    ] as const) {
      expect(verifyTaxQuoteResult(request, successful(rebound))).toMatchObject({ code: "tax_reference_conflict", field });
    }
  });

  it("requires one metadata row per assessed tax position and fee and rejects orphans", () => {
    const result = successful();
    const { tax, fees } = receipt.positions;
    for (const [positions, field] of [
      [{ tax: [], fees }, "/evidence/positions/tax"],
      [{ tax: [...tax, tax[0]], fees }, "/evidence/positions/tax/1"],
      [{ tax: [...tax, { ...tax[0], positionRef: "orphan" }], fees }, "/evidence/positions/tax"],
      [{ tax, fees: [] }, "/evidence/positions/fees"],
      [{ tax, fees: [...fees, fees[0]] }, "/evidence/positions/fees/1"],
    ] as const) {
      expect(verifyTaxQuoteResult(request, successful({ ...receipt, positions }))).toMatchObject({
        code: "tax_breakdown_incomplete", field,
      });
    }
    expect(verifyTaxQuoteResult(request, { ...result, money: { ...money, fees: [] } })).toMatchObject({
      code: "tax_breakdown_incomplete", field: "/evidence/positions/fees",
    });
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
    const { amountMinor: _amount, ...common } = reverse;
    for (const reversal of [reverse, { ...common, mode: "full" }, { ...common, mode: "lines" }]) {
      expect(taxReverseRequestV1Schema.parse(reversal)).toEqual(reversal);
      refuses(() => taxReverseRequestV1Schema.parse({ ...reversal, positions: [] }), "/positions");
      refuses(() => taxReverseRequestV1Schema.parse({
        ...reversal, positions: [{ ...reverse.positions[0], netDeltaMinor: -1, taxDeltaMinor: 0, feeDeltaMinor: 0 }],
      }), "/positions");
      for (const key of ["netDeltaMinor", "taxDeltaMinor", "feeDeltaMinor"]) {
        refuses(() => taxReverseRequestV1Schema.parse({
          ...reversal, positions: [{ ...reverse.positions[0], [key]: 60 }],
        }), "/positions/0/" + key);
      }
    }
    const { feeEvidenceRef: _feeEvidence, ...noFeeEvidence } = reverse;
    refuses(() => taxReverseRequestV1Schema.parse(noFeeEvidence), "/feeEvidenceRef");
  });
});
