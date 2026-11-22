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

const writeExpected = "Write `expected` at `field`, then refresh the digests.";

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
      kind: "refused", code: "tax_reference_conflict", field: "/inputDigest", remedy: writeExpected, expected: makeTaxQuoteRequest("key", altered.input).inputDigest,
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
      code: "tax_breakdown_incomplete", field: "/money/components/0/initial/taxPositions/0/jurisdictionRef",
      remedy: "Re-obtain the position or fee for a required cell of the original request.",
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

  const coverageFor = (original: TaxQuoteRequestV1) => reconcileTaxCoverage({
    scope, taxDate: date, coverage: original.input.coverage, required: original.input.required,
    observations: original.input.required.map(cell => ({ cell, registration: active, treatment: taxable, assessedMinor: 0 })),
  }).vector;
  const resultWith = (original: TaxQuoteRequestV1, assessment = money, evidence = receipt, rows = evidence.coverage.vector) => {
    const bound = bindFiscal({
      ...evidence, status: original.input.purpose, inputDigest: original.inputDigest,
      coverage: { vector: rows, digest: taggedDigest("coverage", rows) },
    });
    return { kind: bound.status, money: assessment, evidence: bound, evidenceDigest: taggedDigest("evidence", bound) } as TaxQuoteResultV1;
  };

  it("applies verifier repair values through one JSON Pointer writer", () => {
    type Success = Extract<TaxQuoteResultV1, { kind: "final" | "estimate" }>;
    type Example = { original: TaxQuoteRequestV1; result: Success };
    type Refusal = Extract<TaxQuoteResultV1, { kind: "refused" }>;
    type Edit = readonly [path: string, value: unknown];
    type Probe = {
      field: string; remedy?: string; code: Refusal["code"];
      broken: readonly Edit[]; base?: Example; shared?: boolean; fiscalPatch?: boolean; stale?: Edit;
    };
    const example = (original = request, result = resultWith(original)): Example => {
      if (result.kind !== "final" && result.kind !== "estimate") throw new Error("Expected calculation evidence.");
      return { original, result };
    };
    const edit = (document: unknown, [path, value]: Edit) => {
      const keys = path.slice(1).split("/").map(key => key.replaceAll("~1", "/").replaceAll("~0", "~"));
      const key = keys.pop()!;
      const parent = keys.reduce((node, key) => (node as Record<string, unknown>)[key], document as unknown);
      if (Array.isArray(parent) && value === undefined) parent.splice(Number(key), 1);
      else if (value === undefined) delete (parent as Record<string, unknown>)[key];
      else (parent as Record<string, unknown>)[key] = structuredClone(value);
    };
    const refresh = ({ original, result }: { original: TaxQuoteRequestV1; result: Pick<Success, "evidence" | "evidenceDigest"> },
      preserve?: Edit) => {
      const document = { original, result };
      const { evidence } = result;
      const hash = (path: string, digest: string) => edit(document, [path, preserve?.[0] === path ? preserve[1] : digest]);
      hash("/original/inputDigest", taggedDigest("input", original.input));
      evidence.positions.tax.forEach((position, index) =>
        hash("/result/evidence/positions/tax/" + index + "/resolutionDigest", taggedDigest("resolution", position.resolution)));
      hash("/result/evidence/coverage/digest", taggedDigest("coverage", evidence.coverage.vector));
      hash("/result/evidence/fiscalDigest", fiscalHash(evidence));
      hash("/result/evidenceDigest", taggedDigest("evidence", evidence));
    };

    const recompute = (document: Example, edits: readonly Edit[], stale?: Edit) => {
      const { original, result } = document;
      if (edits.some(([path]) => path.startsWith("/result/money/"))) {
        const { components, fees, netTotal } = result.money;
        const states = components.map(({ ref, initial, allocations }) => ({
          ref, states: [initial, ...allocations.map(row => row.after)].map(({ amountMinor, taxPositions }, index) =>
            ({ afterSequence: index === 0 ? 0 : allocations[index - 1].sequence, amountMinor, taxPositions })),
        }));
        const taxTotal = states.flatMap(row => row.states.at(-1)!.taxPositions).reduce((sum, row) => sum + row.taxMinor, 0);
        const payableMinor = netTotal + taxTotal + fees.reduce((sum, fee) => sum + fee.amountMinor, 0);
        edit(document, ["/result/money", calculateCatalogueMoneyV2({ ...original.input.money, fees }, {
          kind: "provider", components: states, payableMinor,
        })]);
      }

      refresh(document, stale);
    };

    const tax = "/evidence/positions/tax/0";
    const fee = "/evidence/positions/fees/0";
    const position = "/money/components/0/initial/taxPositions/0";
    const moneyFee = "/money/fees/0";
    const rowIndex = vector.findIndex(row => row.cell.target.key === "item-a");
    const covered = "/evidence/coverage/vector/" + rowIndex;
    const feeIndex = vector.findIndex(row => row.cell.target.kind === "fee");
    const feeCoverage = "/result/evidence/coverage/vector/" + feeIndex;
    const estimated = makeTaxQuoteRequest("estimate-remedies", { ...request.input, purpose: "estimate" });
    const estimate = example(estimated);
    const zero = { ...money.fees[0], amountMinor: 0 };
    const exempt = (target: typeof vector[number]["cell"]["target"]["kind"]) => vector.map(row => row.cell.target.kind === target
      ? { ...row, decision: "in_scope_exempt" as const, treatment: { ...taxable, kind: "exempt" as const } } : row);
    const feeExempt = example(request, resultWith(request, localMoney(request.input.money, "district-a", "8.125000", [zero]), receipt, exempt("fee")));
    const zeroTax = { ...receipt, positions: { ...receipt.positions, tax: [{ ...receipt.positions.tax[0], ratePercent: "0" }] } };
    const taxExempt = example(request, resultWith(request, localMoney(request.input.money, "district-a", "0"), zeroTax, exempt("line")));
    const omitted = makeTaxQuoteRequest("omit-fee", { ...estimated.input, coverage: { ...estimated.input.coverage,
      declarations: estimated.input.coverage.declarations.map(row => row.taxKind !== "fee-a" ? row
        : { ...row, status: "not_registered_acknowledged" as const, acknowledgementRef: "ack" }),
    } });
    const absentFee = { ...receipt, positions: { ...receipt.positions, fees: [] } };
    const outOfScope = example(omitted, resultWith(omitted, localMoney(omitted.input.money, "district-a", "8.125000", []), absentFee,
      vector.map(row => row.cell.target.kind === "fee" ? { cell: row.cell, decision: "out_of_scope" as const,
        declaration: omitted.input.coverage.declarations.find(row => row.taxKind === "fee-a"),
        registration: { ...active, state: "inactive" as const },
      } : row)));
    const unrepeated = calculateCatalogueMoneyV2({ ...request.input.money, fees: money.fees }, {
      kind: "local", components: planCatalogueMoneyV2(request.input.money).components.map(({ ref }) => ({
        ref, rates: ref.kind === "delivery" ? [] : [{
          positionRef: ref.lineKey, jurisdictionRef: ref.lineKey === "item-z" ? "district-a" : "district-b", rateDecimal: "8.125000",
        }],
      })),
    });
    const distinct = example(request, resultWith(request, unrepeated, { ...receipt, positions: {
      fees: receipt.positions.fees, tax: ["item-z", "item-a"].map((positionRef, index) => ({
        ...receipt.positions.tax[0], positionRef, cell: cell(positionRef, index === 0 ? "district-a" : "district-b"),
      })),
    } }));

    const noRate = structuredClone(example());
    const omitRate: Edit[] = [
      ["/result/money/components/0/initial/taxPositions/0/rateDecimal", undefined],
      ...money.components[0].allocations.map((_, index) =>
        ["/result/money/components/0/allocations/" + index + "/after/taxPositions/0/rateDecimal", undefined] as const),
    ];
    for (const change of omitRate) edit(noRate, change);
    edit(noRate, ["/result" + tax + "/ratePercent", undefined]);
    recompute(noRate, omitRate);
    const otherCell = cell("item-a");
    const split = makeTaxQuoteRequest("split-binding", { ...request.input,
      lines: request.input.lines.map(line => line.lineKey === "item-a" ? { ...line, assignmentRef: "assignment-b" } : line),
      required: request.input.required.map(cell => cell.target.key === "item-a" ? otherCell : cell),
    });
    const splitResult = example(split, resultWith(split, money, receipt, coverageFor(split).map(row =>
      row.cell.target.key === "item-a" ? { ...row, treatment: { ...taxable, ruleRef: "rule-b" } } : row)));

    const editField = (code: Probe["code"], field: string, remedy: string | undefined, value: unknown, options: Partial<Probe> = {}): Probe =>
      ({ code, field, remedy, broken: [["/result" + field, value]], ...options });
    const assessment = (field: string, remedy: string | undefined, value: unknown, options?: Partial<Probe>) =>
      editField("tax_breakdown_incomplete", field, remedy, value, options);
    const binding = (field: string, remedy: string | undefined, value: unknown, options?: Partial<Probe>) =>
      editField("tax_reference_conflict", field, remedy, value, { shared: true, ...options });
    const stale = (field: string, path = "/result" + field) =>
      binding(field, undefined, digest, { broken: [], stale: [path, digest] });
    const moneyIdentity = "Re-obtain the position or fee for a required cell of the original request.";
    const zeroAssessment = "Re-obtain the calculation with zero assessment for the covered exemption or exclusion and reconcile payable.";
    const observed = "Reconcile the named cell from effective observations.";
    const supplyRow = "Supply one matching metadata row in the evidence.";
    const probes: Probe[] = [
      stale("/inputDigest", "/original/inputDigest"),
      stale("/evidenceDigest"),
      stale("/evidence/coverage/digest"),
      stale(tax + "/resolutionDigest"),
      stale("/evidence/fiscalDigest"),
      ...Object.entries({
        scope: { ...scope, adapterVersion: "2" }, taxDate: "2030-01-02T00:00:00.000Z",
        inputDigest: digest, destinationDigest: "b".repeat(64), shipFromRef: "different-origin",
        policyRevision: "different-policy", classMapRevision: "different-classes",
      }).map(([field, value]) => binding("/evidence/" + field, undefined, value)),
      binding("/evidence/status", "Use the original quote's purpose for the evidence status and any result kind.", "estimate", {
        broken: [["/result/evidence/status", "estimate"], ["/result/kind", "estimate"]],
        fiscalPatch: true,
      }),
      editField("tax_calculation_unusable", "/evidence/status", undefined, "estimate"),
      editField("tax_calculation_unusable", "/kind", undefined, "estimate"),
      binding("/evidence/coverage/vector", "Reconcile the original quote's required cells.", vector.filter((_, i) => i !== rowIndex)),
      binding(covered + "/declaration", undefined,
        { ...vector[rowIndex].declaration, actorRef: "other" }),
      editField("tax_calculation_unusable", covered + "/decision", observed, "undeclared", { base: estimate, shared: true }),
      editField("tax_calculation_unusable", covered + "/decision", observed, "undeclared", { shared: true }),
      editField("tax_calculation_unusable", covered + "/decision", observed, "in_scope_exempt", { shared: true }),
      editField("tax_invalid_input", "/evidence/coverage/vector/1", "Supply uniquely ordered coverage cells.", vector[0], { shared: true }),
      editField("tax_invalid_input", covered + "/declaration", "Supply the effective declaration for this cell.",
        { ...vector[rowIndex].declaration, jurisdiction: "other" }, { shared: true }),
      editField("tax_invalid_input", covered + "/registration", "Supply the registration effective on the tax date.",
        { ...active, effective: { from: later } }, { shared: true }),
      editField("tax_invalid_input", "/evidence/expiresAt", "Supply an expiry after calculation.", date, { shared: true }),
      editField("tax_invalid_input", tax + "/resolution/effective", "Supply a rule resolution effective on the tax date.", { from: later }, { shared: true }),
      binding(tax + "/resolution/assignmentRef", undefined, "other-assignment"),
      binding(tax + "/resolution/policyRevision", undefined, "other-policy"),
      binding(tax + "/ruleRef", undefined, "other-rule"),
      binding(tax, undefined, { ...receipt.positions.tax[0],
        resolution: { ...resolution, assignmentRef: "wrong-assignment" }, ruleRef: "wrong-rule",
      }),
      assessment(position + "/jurisdictionRef", moneyIdentity, "district-b"),
      assessment(moneyFee + "/feeKey", moneyIdentity, "other-fee"),
      assessment("/money/components/1/initial/taxPositions/0/positionRef",
        "Re-obtain consistent position identities across states. Supply distinct refs for distinct positions.", "item-z", { base: distinct }),
      assessment(position + "/positionRef", supplyRow, undefined, { broken: [["/result" + tax, undefined]] }),
      assessment(moneyFee + "/feeKey", supplyRow, undefined, { broken: [["/result" + fee, undefined]] }),
      ...(["tax", "fees"] as const).flatMap(kind => {
        const path = "/evidence/positions/" + kind + "/1";
        const field = kind === "tax" ? "positionRef" : "feeKey";
        return [
          assessment(path, "Remove the duplicate identity.", receipt.positions[kind][0], { shared: true }),
          assessment(path + "/" + field, "Remove this metadata row.", undefined, {
            broken: [["/result" + path, { ...receipt.positions[kind][0], [field]: "orphan" }]],
          }),
        ];
      }),
      ...Object.entries({ jurisdiction: "district-b", target: cell("item-a").target, sourcing: "ship_from", level: "other", taxKind: "other" })
        .map(([key, value]) => assessment(tax + "/cell/" + key, undefined, value)),
      assessment(tax + "/cell", undefined, cell("item-a", "district-b")),
      assessment(tax + "/cell", undefined, { ...cell(), sourcing: "ship_from", level: "other" }),
      assessment(tax, undefined, { ...receipt.positions.tax[0], cell: otherCell,
        resolution: { ...resolution, assignmentRef: "assignment-b" }, ruleRef: "rule-b",
      }, { base: splitResult }),
      ...Object.entries({ jurisdiction: "district-b", feeKind: "sale", scope: { kind: "order" } })
        .map(([key, value]) => assessment(fee + "/" + key, undefined, value)),
      assessment(fee, undefined, { ...receipt.positions.fees[0], jurisdiction: "district-b", scope: { kind: "order" },
        providerPositionRef: "provider-fee" }),
      assessment(tax + "/ratePercent", undefined, undefined),
      assessment(tax + "/ratePercent", undefined, "9"),
      assessment(tax, undefined, undefined, { base: noRate, broken: [["/result" + tax + "/ratePercent", "9"]] }),
      assessment(position + "/taxMinor", zeroAssessment, 1, { base: taxExempt }),
      assessment(moneyFee + "/amountMinor", zeroAssessment, 5, { base: feeExempt }),
      assessment(moneyFee + "/feeKey", "Omit the out-of-scope fee and its metadata, then reconcile payable.", undefined, {
        base: outOfScope, broken: [["/result" + moneyFee, zero], ["/result" + fee, receipt.positions.fees[0]]],
      }),
      assessment(moneyFee + "/feeKey", "Obtain the missing proof before emitting an assessment.", undefined, {
        base: estimate, broken: [[feeCoverage, { cell: vector[feeIndex].cell, decision: "unavailable_evidence",
          declaration: vector[feeIndex].declaration }]],
      }),
    ];

    const checkRepair = (verify: () => Refusal | undefined, root: unknown, refreshDigests: (value: Edit) => void,
      field: string, code: Probe["code"], remedy: string | undefined, label: string) => {
      const refusal = verify();
      expect(refusal, label).toMatchObject({ kind: "refused", code, field, remedy: remedy ?? writeExpected });
      if (remedy) {
        expect(refusal, label).not.toHaveProperty("expected");
        return;
      }
      expect(refusal?.expected, label).toBeDefined();
      const replacement: Edit = [refusal!.field, refusal!.expected];
      edit(root, replacement);
      refreshDigests(replacement);
      expect(verify(), "repaired " + label).toBeUndefined();
    };

    for (const { base = example(), code, field, remedy, broken, stale, shared, fiscalPatch } of probes) {
      const changed = structuredClone(base);
      for (const change of broken) edit(changed, change);
      recompute(changed, broken, stale);
      const validity = structuredClone({ ...fiscal, original: changed.original,
        evidence: changed.result.evidence, evidenceDigest: changed.result.evidenceDigest });

      const inRequest = Object.hasOwn(changed.original, field.split("/")[1]);
      const label = field + " (" + base.result.kind + ")";
      expect(verifyTaxQuoteResult(base.original, base.result), "control " + label).toBeUndefined();
      checkRepair(() => verifyTaxQuoteResult(changed.original, changed.result), inRequest ? changed.original : changed.result,
        ([path, value]) => refresh(changed, [(inRequest ? "/original" : "/result") + path, value]), field, code, remedy, label);
      if (shared) {
        const fiscalField = inRequest ? "/original" + field : field;
        checkRepair(() => verifyTaxQuoteRequest(validity), validity,
          ([path, value]) => refresh({ original: validity.original, result: validity },
            [inRequest ? path : "/result" + path, value]), fiscalField, code, fiscalPatch ? undefined : remedy, "fiscal " + label);
      }
    }
  });

  it.each(["order", "delivery"] as const)("uses the same coverage amount rule for %s fees in final and estimate results", kind => {
    const feeScope = kind === "order" ? { kind } : { kind, key: "shipping-a" };
    const required = request.input.required.map(row => {
      if (row.target.kind !== "fee" || kind !== "order") return row;
      const { deliveryKey: _delivery, ...target } = row.target;
      return { ...row, target };
    });
    const evidence = { ...receipt, positions: { ...receipt.positions, fees: [{ ...receipt.positions.fees[0], scope: feeScope }] } };
    for (const purpose of ["final", "estimate"] as const) {
      const original = makeTaxQuoteRequest("fee-coverage", { ...request.input, required, purpose });
      const taxed = coverageFor(original);
      const exempt = taxed.map(row => row.cell.target.kind === "fee"
        ? { ...row, decision: "in_scope_exempt" as const, treatment: { ...taxable, kind: "exempt" as const } } : row);
      for (const fees of [evidence.positions.fees, []]) {
        const supplied = { ...evidence, positions: { ...evidence.positions, fees } };
        expect(verifyTaxQuoteResult(original, resultWith(original, money, supplied, exempt))).toEqual({
          kind: "refused", code: "tax_breakdown_incomplete", field: "/money/fees/0/amountMinor",
          remedy: "Re-obtain the calculation with zero assessment for the covered exemption or exclusion and reconcile payable.",
        });
      }
      const zero = localMoney(original.input.money, "district-a", "8.125000", [{ feeKey: "fee-a", amountMinor: 0 }]);
      expect(verifyTaxQuoteResult(original, resultWith(original, zero, evidence, exempt))).toBeUndefined();
      expect(verifyTaxQuoteResult(original, resultWith(original, money, evidence, taxed))).toBeUndefined();
    }
  });

  it("refuses emitted fees outside scope or without resolved coverage even at zero", () => {
    const zero = localMoney(request.input.money, "district-a", "8.125000", [{ feeKey: "fee-a", amountMinor: 0 }]);
    for (const decision of ["out_of_scope", "unavailable_evidence"] as const) {
      const excluded = decision === "out_of_scope";
      const declarations = request.input.coverage.declarations.map(declaration =>
        excluded && declaration.taxKind === "fee-a"
          ? { ...declaration, status: "not_registered_acknowledged" as const, acknowledgementRef: "ack-a" } : declaration);
      const original = makeTaxQuoteRequest("fee-omission", {
        ...request.input, purpose: "estimate", coverage: { ...request.input.coverage, declarations },
      });
      const rows = vector.map(row => row.cell.target.kind === "fee" ? {
        cell: row.cell, decision, declaration: declarations.find(declaration => declaration.taxKind === "fee-a"),
        ...(excluded && { registration: { ...active, state: "inactive" as const } }),
      } : row);
      expect(verifyTaxQuoteResult(original, resultWith(original, zero, receipt, rows))).toEqual({
        kind: "refused", code: "tax_breakdown_incomplete", field: "/money/fees/0/feeKey",
        remedy: excluded ? "Omit the out-of-scope fee and its metadata, then reconcile payable." : "Obtain the missing proof before emitting an assessment.",
      });
    }
  });

  it("diagnoses tax and fee identity on the repairable side with or without metadata", () => {
    const { tax, fees } = receipt.positions;
    const moneyFix = "Re-obtain the position or fee for a required cell of the original request.";
    for (const present of [false, true]) {
      // The second jurisdiction exists only on a different merchandise line.
      for (const jurisdiction of ["unknown-district", "district-b"]) {
        const badTax = present ? [{ ...tax[0], cell: cell("item-z", jurisdiction) }] : [];
        const result = localMoney(request.input.money, jurisdiction);
        expect(verifyTaxQuoteResult(request, resultWith(request, result, { ...receipt, positions: { tax: badTax, fees } })))
          .toEqual({ kind: "refused", code: "tax_breakdown_incomplete", field: "/money/components/0/initial/taxPositions/0/jurisdictionRef", remedy: moneyFix });
      }
      const result = localMoney(request.input.money, "district-a", "8.125000", [{ feeKey: "unknown-fee", amountMinor: 5 }]);
      const badFees = present ? [{ ...fees[0], feeKey: "unknown-fee" }] : [];
      expect(verifyTaxQuoteResult(request, resultWith(request, result, { ...receipt, positions: { tax, fees: badFees } })))
        .toEqual({ kind: "refused", code: "tax_breakdown_incomplete", field: "/money/fees/0/feeKey", remedy: moneyFix });
    }
    expect(verifyTaxQuoteResult(request, successful())).toBeUndefined();

    const another = cell("item-z", "district-b");
    const original = makeTaxQuoteRequest("second-jurisdiction", { ...request.input, required: [...request.input.required, another] });
    const rows = coverageFor(original);
    const result = localMoney(original.input.money, another.jurisdiction);
    expect(verifyTaxQuoteResult(original, resultWith(original, result, receipt, rows))).toEqual({
      kind: "refused", code: "tax_breakdown_incomplete", field: "/evidence/positions/tax/0/cell/jurisdiction", remedy: writeExpected, expected: "district-b",
    });
    expect(verifyTaxQuoteResult(original, resultWith(original, result, { ...receipt, positions: { tax: [], fees } }, rows))).toEqual({
      kind: "refused", code: "tax_breakdown_incomplete", field: "/money/components/0/initial/taxPositions/0/positionRef", remedy: "Supply one matching metadata row in the evidence.",
    });
    const corrected = { ...receipt, positions: { tax: [{ ...tax[0], cell: another }], fees } };
    expect(verifyTaxQuoteResult(original, resultWith(original, result, corrected, rows))).toBeUndefined();

    for (const [change, field, value] of [
      [{ jurisdiction: "district-b" }, "/jurisdiction", fees[0].jurisdiction],
      [{ feeKind: "sale" }, "/feeKind", fees[0].feeKind],
      [{ scope: { kind: "order" } }, "/scope", fees[0].scope],
    ] as const) {
      const altered = { ...receipt, positions: { tax, fees: [{ ...fees[0], ...change }] } };
      expect(verifyTaxQuoteResult(request, resultWith(request, money, altered))).toEqual({
        kind: "refused", code: "tax_breakdown_incomplete", field: "/evidence/positions/fees/0" + field,
        remedy: writeExpected, expected: value,
      });
    }
    expect(verifyTaxQuoteResult(request, resultWith(request))).toBeUndefined();
  });

  it("rejects reuse of a position ref for a different jurisdiction, rate or component", () => {
    const original = makeTaxQuoteRequest("repeat-ref", {
      ...request.input, required: [...request.input.required, cell("item-z", "district-b")],
    });
    const rows = coverageFor(original);
    const [first, ...remaining] = money.components;
    const [allocation] = first.allocations;
    const earliest = "/money/components/0/allocations/0/after/taxPositions/0/positionRef";
    const remedy = "Re-obtain consistent position identities across states. Supply distinct refs for distinct positions.";
    for (const changed of [{ jurisdictionRef: "district-b" }, { rateDecimal: "9" }]) {
      const after = { ...allocation.after, taxPositions: [{ ...allocation.after.taxPositions[0], ...changed }] };
      const altered = { ...money, components: [{ ...first, allocations: [{ ...allocation, after }], final: after }, ...remaining] };
      expect(verifyTaxQuoteResult(original, resultWith(original, altered, receipt, rows))).toEqual({
        kind: "refused", code: "tax_breakdown_incomplete", field: earliest, remedy,
      });
    }
    const both = calculateCatalogueMoneyV2({ ...original.input.money, fees: money.fees }, {
      kind: "local", components: planCatalogueMoneyV2(original.input.money).components.map(({ ref }) => ({
        ref, rates: ref.kind === "delivery" ? [] : [{
          positionRef: "position-a", jurisdictionRef: ref.lineKey === "item-z" ? "district-a" : "district-b", rateDecimal: "8.125000",
        }],
      })),
    });
    expect(verifyTaxQuoteResult(original, resultWith(original, both, receipt, rows))).toEqual({
      kind: "refused", code: "tax_breakdown_incomplete", field: "/money/components/1/initial/taxPositions/0/positionRef", remedy,
    });
    expect(verifyTaxQuoteResult(original, resultWith(original, money, receipt, rows))).toBeUndefined();
  });

  it("requires possible estimate decisions through both verifiers and preserves partial and duplicate observations", () => {
    const original = makeTaxQuoteRequest("partial-estimate", { ...request.input, purpose: "estimate" });
    const index = vector.findIndex(row => row.cell.target.key === "item-a");
    const { cell, declaration } = vector[index];
    for (const [row, allowed] of [
      [{ ...vector[index], decision: "undeclared" }, false],
      [{ ...vector[index], decision: "unavailable_evidence", registration: { ...active, state: "inactive" } }, false],
      [{ ...vector[index], decision: "unavailable_evidence" }, true],
      [{ cell, declaration, decision: "inconsistent" }, true],
    ] as const) {
      const result = resultWith(original, money, receipt, vector.map((previous, i) => i === index ? row : previous));
      if (result.kind !== "estimate") throw new Error("Expected an estimate.");
      const validation = { ...fiscal, original, evidence: result.evidence, evidenceDigest: result.evidenceDigest };
      const probes = [verifyTaxQuoteResult(original, result), verifyTaxQuoteRequest(validation)];
      for (const probe of probes) {
        if (allowed) expect(probe).toBeUndefined();
        else expect(probe).toEqual({
          kind: "refused", code: "tax_calculation_unusable", field: "/evidence/coverage/vector/" + index + "/decision",
          remedy: "Reconcile the named cell from effective observations.",
        });
      }
    }
  });

  it("binds tax metadata's policy revision and rule ref in quotes and fiscal validity", () => {
    for (const field of ["resolution/policyRevision", "ruleRef"] as const) {
      const [position] = receipt.positions.tax;
      const resolution = field === "ruleRef" ? position.resolution : { ...position.resolution, policyRevision: "other-policy" };
      const tax = [{ ...position, resolution, resolutionDigest: taggedDigest("resolution", resolution),
        ruleRef: field === "ruleRef" ? "other-rule" : position.ruleRef }];
      const evidence = bindFiscal({ ...receipt, positions: { ...receipt.positions, tax } });
      const expected = { kind: "refused", code: "tax_reference_conflict", field: "/evidence/positions/tax/0/" + field };
      expect(verifyTaxQuoteResult(request, successful(evidence))).toMatchObject(expected);
      expect(verifyTaxQuoteRequest({ ...fiscal, evidence, evidenceDigest: taggedDigest("evidence", evidence) })).toMatchObject(expected);
    }
  });

  it("refuses malformed result projections at the failing pointer", () => {
    const result = successful();
    const [first, ...remaining] = money.components;
    const [allocation] = first.allocations;
    const { after: _after, ...missingAfter } = allocation;
    for (const [bad, field] of [
      [null, ""], [{ ...result, kind: "other" }, "/kind"], [{ ...result, money: null }, "/money"],
      [{ ...result, money: { ...money, components: null } }, "/money/components"],
      [{ ...result, money: { ...money, components: [{ ...first, allocations: [missingAfter] }, ...remaining] } },
        "/money/components/0/allocations/0/after"],
      [{ ...result, money: { ...money, get payableMinor() { throw new Error("Accessor must not run."); } } }, "/money/payableMinor"],
    ] as const) {
      expect(verifyTaxQuoteResult(request, bad as unknown as TaxQuoteResultV1)).toMatchObject({
        kind: "refused", code: "tax_invalid_input", field,
      });
    }
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
