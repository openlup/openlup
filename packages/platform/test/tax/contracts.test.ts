import { createHash } from "node:crypto";
import { calculateCatalogueMoneyV2, planCatalogueMoneyV2 } from "@openlup/core/pricing";
import { describe, expect, it } from "vitest";
import { canonicalCatalogDraftJson } from "../../src/catalog/contracts/index.js";
import { makeTaxQuoteRequest, reconcileTaxCoverage, verifyTaxQuoteRequest, verifyTaxQuoteResult } from "../../src/tax/index.js";
import {
  taxCalculationEvidenceV1Schema, taxCloseInputV1Schema, taxCommitRequestV1Schema, taxCoverageV1Schema,
  taxFiscalValidityRequestV1Schema, taxQuoteRequestV1Schema, taxReverseRequestV1Schema,
} from "../../src/tax/contracts/index.js";
import type { TaxCalculationEvidenceV1, TaxQuoteRequestV1, TaxQuoteResultV1 } from "../../src/tax/contracts/index.js";
import { active, cell, coverage, date, digest, later, quote, registered, scope, taxable } from "./fixtures.js";

function refuses(run: () => unknown, field: string): void {
  expect(run).toThrow(expect.objectContaining({ field }));
}

function taggedDigest(tag: "input" | "coverage" | "evidence" | "fiscal" | "resolution", value: unknown): string {
  return createHash("sha256").update(canonicalCatalogDraftJson(["platform.tax." + tag + ".v1", value])).digest("hex");
}

function fiscalHash(evidence: TaxCalculationEvidenceV1): string {
  const { scope, destinationDigest, shipFromRef, policyRevision, classMapRevision, coverage, positions } = evidence;
  return taggedDigest("fiscal", {
    scope, destinationDigest, shipFromRef, policyRevision, classMapRevision, coverage: coverage.vector,
    tax: positions.tax.map(({ resolutionDigest: _digest, providerLineRef: _provider, ...row }) => row),
    fees: positions.fees,
  });
}

function bindFiscal(evidence: TaxCalculationEvidenceV1): TaxCalculationEvidenceV1 {
  return { ...evidence, fiscalDigest: fiscalHash(evidence) };
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
  const resolution = { assignmentRef: "assignment-a", policyRevision: "policy-a", sourceRef: "table-a", effective: { from: date } };
  const receipt = bindFiscal({
    scope, calculationRef: "calculation-a", status: "final", calculatedAt: date, expiresAt: later,
    taxDate: date, destinationDigest: digest, shipFromRef: request.input.shipFromRef, inputDigest: request.inputDigest,
    policyRevision: request.input.policyRevision, classMapRevision: request.input.classMapRevision,
    coverage: { vector, digest: coverageDigest }, fiscalDigest: digest,
    positions: { fees: [{
      feeKey: "fee-a", jurisdiction: "district-a", feeKind: "fee-a", scope: { kind: "delivery", key: "shipping-a" },
      refundRule: { ref: "fee-rule", revision: "revision-a" },
    }], tax: [{
      positionRef: "position-a", cell: cell(), ratePercent: "8.125000", taxabilityReason: "standard", ruleRef: "rule-a",
      resolution, resolutionDigest: taggedDigest("resolution", resolution), providerLineRef: "provider-line-a",
    }] },
  });

  const localMoney = (input = request.input.money, jurisdictionRef = "district-a", rateDecimal = "8.125000",
    fees = [{ feeKey: "fee-a", amountMinor: 5 }]) => calculateCatalogueMoneyV2({ ...input, fees }, {
    kind: "local",
    components: planCatalogueMoneyV2(input).components.map(({ ref }) => ({
      ref, rates: ref.kind === "merchandise" && ref.lineKey === "item-z"
        ? [{ positionRef: "position-a", jurisdictionRef, rateDecimal }] : [],
    })),
  });
  const money = localMoney();
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
      [{ tax: [], fees }, "/money/components/0/initial/taxPositions/0/positionRef"],
      [{ tax: [...tax, tax[0]], fees }, "/evidence/positions/tax/1"],
      [{ tax: [...tax, { ...tax[0], positionRef: "orphan" }], fees }, "/evidence/positions/tax/1/positionRef"],
      [{ tax, fees: [] }, "/money/fees/0/feeKey"],
      [{ tax, fees: [...fees, fees[0]] }, "/evidence/positions/fees/1"],
    ] as const) {
      expect(verifyTaxQuoteResult(request, successful(bindFiscal({ ...receipt, positions })))).toMatchObject({
        code: "tax_breakdown_incomplete", field,
      });
    }
    expect(verifyTaxQuoteResult(request, { ...result, money: localMoney(request.input.money, "district-a", "8.125000", []) })).toMatchObject({
      code: "tax_breakdown_incomplete", field: "/evidence/positions/fees/0/feeKey",
    });
    const zeroMoney = localMoney(request.input.money, "district-a", "0");
    const zero = bindFiscal({ ...receipt, positions: { ...receipt.positions, tax: [] } });
    expect(verifyTaxQuoteResult(request, { ...successful(zero), money: zeroMoney })).toMatchObject({
      code: "tax_breakdown_incomplete", field: "/money/components/0/initial/taxPositions/0/positionRef",
    });
  });

  it("recomputes money against the original plan and names the first different field", () => {
    const sources = request.input.money.sources.map(row => row.lineKey === "item-z" ? { ...row, unitBasisMinor: 1_000 } : row);
    const repriced = localMoney({ ...request.input.money, sources });
    expect(repriced.payableMinor).toBeGreaterThan(money.payableMinor);
    const result = successful();
    expect(verifyTaxQuoteResult(request, { ...result, money: repriced })).toMatchObject({
      code: "tax_breakdown_incomplete", field: "/money/components/0/initial/amountMinor",
    });
    const [first, ...components] = money.components;
    const [allocation, ...allocations] = first.allocations;
    const altered = { ...first, allocations: [{ ...allocation, netReductionMinor: 0 }, ...allocations] };
    expect(verifyTaxQuoteResult(request, { ...result, money: { ...money, components: [altered, ...components] } })).toMatchObject({
      code: "tax_breakdown_incomplete", field: "/money/components/0/allocations/0/netReductionMinor",
    });
    expect(verifyTaxQuoteResult(request, { ...result, money: { ...money, netTotal: 1 } })).toMatchObject({
      code: "tax_breakdown_incomplete", field: "/money/netTotal",
    });
    expect(verifyTaxQuoteResult(request, { ...result, money: { ...money, payableMinor: 1 } })).toMatchObject({
      code: "tax_breakdown_incomplete", field: "/money/payableMinor",
    });
  });

  it("refuses a genuine inclusive result with positive tax and no money positions", () => {
    const inclusive = { ...request.input.money, amountBasis: "inclusive" as const };
    const inclusiveResult = calculateCatalogueMoneyV2(inclusive, {
      kind: "inclusive", components: planCatalogueMoneyV2(inclusive).components
        .filter(({ ref }) => ref.kind === "merchandise").map(({ ref }) => ({ ref, rateBps: 2_000 })),
    });
    expect(inclusiveResult.taxTotal).toBeGreaterThan(0);
    expect(inclusiveResult.components.every(row => row.final.taxPositions.length === 0)).toBe(true);
    for (const skip of [false, true]) {
      const declarations = skip ? request.input.coverage.declarations.map(declaration => ({
        ...declaration, status: "not_registered_acknowledged" as const, acknowledgementRef: "ack-a",
      })) : request.input.coverage.declarations;
      const input = { ...request.input, money: inclusive, coverage: { ...request.input.coverage, declarations } };
      const requestWithInclusiveMoney = { key: request.key, input, inputDigest: taggedDigest("input", input) };
      const coverage = skip ? reconcileTaxCoverage({
        scope, taxDate: date, required: input.required, coverage: input.coverage,
        observations: input.required.map(cell => ({ cell, registration: { ...active, state: "inactive" } })),
      }) : receipt.coverage;
      if (skip) expect(coverage).toMatchObject({ kind: "resolved", posting: "skip" });
      const evidence = bindFiscal({
        ...receipt, coverage: { vector: coverage.vector, digest: coverage.digest }, inputDigest: requestWithInclusiveMoney.inputDigest,
        positions: { tax: [], fees: [] },
      });
      const refusal = {
        code: "tax_scope_mismatch", field: "/input/money/amountBasis", remedy: expect.stringContaining("existing inclusive quote path"),
      };
      expect(taxQuoteRequestV1Schema.safeParse(requestWithInclusiveMoney)).toMatchObject({
        success: false, error: { code: refusal.code, field: refusal.field, message: refusal.remedy },
      });
      const typed = requestWithInclusiveMoney as unknown as TaxQuoteRequestV1;
      expect(verifyTaxQuoteRequest(typed)).toMatchObject(refusal);
      expect(verifyTaxQuoteResult(typed, { ...successful(evidence), money: inclusiveResult })).toMatchObject(refusal);
    }
    expect(verifyTaxQuoteResult(request, { ...successful(), money: inclusiveResult })).toMatchObject({
      code: "tax_scope_mismatch", field: "/money/amountBasis",
    });
  });

  it("binds jurisdiction and rate on every position and rejects positive tax on exempt or out-of-scope cells", () => {
    const result = successful();
    expect(verifyTaxQuoteResult(request, { ...result, money: localMoney(request.input.money, "other-district") })).toMatchObject({
      code: "tax_breakdown_incomplete", field: "/evidence/positions/tax/0/cell/jurisdiction",
    });
    const [position] = receipt.positions.tax;
    const { ratePercent: _rate, ...withoutRate } = position;
    for (const tax of [[{ ...position, ratePercent: "8.125" }], [withoutRate]]) {
      const altered = bindFiscal({ ...receipt, positions: { ...receipt.positions, tax } });
      expect(verifyTaxQuoteResult(request, successful(altered))).toMatchObject({
        code: "tax_breakdown_incomplete", field: "/evidence/positions/tax/0/ratePercent",
      });
    }
    for (const outOfScope of [false, true]) {
      const declarations = request.input.coverage.declarations.map(declaration =>
        outOfScope && declaration.jurisdiction === position.cell.jurisdiction && declaration.taxKind === position.cell.taxKind
          ? { ...declaration, status: "not_registered_acknowledged" as const, acknowledgementRef: "ack-a" } : declaration);
      const original = makeTaxQuoteRequest("coverage-check", { ...request.input, coverage: { ...request.input.coverage, declarations } });
      const coverage = reconcileTaxCoverage({
        scope, taxDate: date, required: original.input.required, coverage: original.input.coverage,
        observations: original.input.required.map(cell => {
          if (cell.jurisdiction !== position.cell.jurisdiction || cell.taxKind !== position.cell.taxKind) {
            return { cell, registration: active, treatment: taxable, assessedMinor: 0 };
          }
          return outOfScope ? { cell, registration: { ...active, state: "inactive" } }
            : { cell, registration: active, treatment: { ...taxable, kind: "exempt" }, assessedMinor: 0 };
        }),
      });
      const covered = bindFiscal({
        ...receipt, inputDigest: original.inputDigest, coverage: { vector: coverage.vector, digest: coverage.digest },
      });
      expect(verifyTaxQuoteResult(original, successful(covered))).toMatchObject({
        code: "tax_breakdown_incomplete", field: "/money/components/0/initial/taxPositions/0/taxMinor",
      });
      const zeroTax = bindFiscal({ ...covered, positions: { ...covered.positions, tax: [{ ...position, ratePercent: "0" }] } });
      expect(verifyTaxQuoteResult(original, { ...successful(zeroTax), money: localMoney(request.input.money, "district-a", "0") }))
        .toBeUndefined();
    }
  });

  it("recomputes fiscal and resolution digests even if the outer evidence digest is refreshed", () => {
    const tax = receipt.positions.tax[0];
    for (const [evidence, field] of [
      [{ ...receipt, fiscalDigest: digest }, "/evidence/fiscalDigest"],
      [{ ...receipt, positions: { ...receipt.positions, tax: [{ ...tax, resolutionDigest: digest }] } },
        "/evidence/positions/tax/0/resolutionDigest"],
      [bindFiscal({
        ...receipt, positions: { ...receipt.positions, tax: [{ ...tax, resolution: { ...tax.resolution, sourceRef: "different-source" } }] },
      }), "/evidence/positions/tax/0/resolutionDigest"],
    ] as const) {
      const result = successful(evidence);
      const refusal = { code: "tax_reference_conflict", field };
      expect(verifyTaxQuoteResult(request, result)).toMatchObject(refusal);
      expect(verifyTaxQuoteRequest({ ...fiscal, evidence, evidenceDigest: result.evidenceDigest })).toMatchObject(refusal);
    }
    const lifecycle = {
      ...receipt, calculationRef: "another-calculation", calculatedAt: later, expiresAt: "2030-03-01T00:00:00.000Z",
      positions: { ...receipt.positions, tax: [{ ...tax, providerLineRef: "another-line" }] },
    };
    expect(fiscalHash(lifecycle)).toBe(receipt.fiscalDigest);
    expect(verifyTaxQuoteResult(request, successful(lifecycle))).toBeUndefined();
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
