import { createHash } from "node:crypto";
import { calculateCatalogueMoneyV2, planCatalogueMoneyV2 } from "@openlup/core/pricing";
import { describe, expect, it } from "vitest";
import { CATALOG_DRAFT_MAX_BYTES, canonicalCatalogDraftJson } from "../../src/catalog/contracts/index.js";
import { makeTaxQuoteRequest, reconcileTaxCoverage, verifyTaxQuoteRequest, verifyTaxQuoteResult } from "../../src/tax/index.js";
import {
  taxCalculationEvidenceV1Schema, taxCloseInputV1Schema, taxCommitRequestV1Schema, taxCoverageV1Schema,
  taxFiscalValidityRequestV1Schema, taxQuoteRequestV1Schema, taxReverseRequestV1Schema,
} from "../../src/tax/contracts/index.js";
import type { TaxCalculationEvidenceV1, TaxQuoteRequestV1, TaxQuoteResultV1, TaxRefusal } from "../../src/tax/contracts/index.js";
import { active, cell, coverage, date, digest, later, quote, registered, scope, taxable } from "./fixtures.js";

function refuses(run: () => unknown, field: string): void {
  expect(run).toThrow(expect.objectContaining({ field }));
}

const remedies = {
  tax_reference_conflict: "Replay the intended original request under its original key with its original digest and, where applicable, its matching calculation evidence and original digests. For fiscal validity, obtain fresh charge-time input from the original scope without copying or relabelling scope members.",
  tax_invalid_input: "Supply the documented value at the indicated field.",
  tax_amount_out_of_range: "Supply amounts within the supported safe-integer range, including the combined basis of all components.",
  tax_scope_mismatch: "Use the existing inclusive quote path for inclusive-tax quotes. This port version calculates exclusive tax.",
  tax_calculation_unusable: "Obtain calculation evidence for the original request with coverage supported by effective observations.",
  tax_breakdown_incomplete: "Recover and replay the complete original calculation breakdown for the intended request and key.",
} as const;
type Code = keyof typeof remedies;
const sizeRemedy = "Reduce the document below 1,048,576 bytes of canonical JSON.";
const verifierRefusal = (code: Code, field: string, remedy: string = remedies[code]) => ({ kind: "refused", code, field, remedy });
const conflict = (field: string) => verifierRefusal("tax_reference_conflict", field);
const breakdown = (field: string) => verifierRefusal("tax_breakdown_incomplete", field);

function expectRefusal(refusal: TaxRefusal | undefined, code: Code, field: string, remedy?: string) {
  expect(refusal, field).toEqual(verifierRefusal(code, field, remedy));
  expect(Reflect.ownKeys(refusal!).sort()).toEqual(["code", "field", "kind", "remedy"]);
  expect(Object.hasOwn(refusal!, "expected")).toBe(false);
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
    const input = makeTaxQuoteRequest("key", quote()).input;
    const money = {
      ...input.money, adjustments: [],
      sources: input.money.sources.map((row, i) => ({ ...row, unitBasisMinor: i ? 0 : Number.MAX_SAFE_INTEGER })),
      delivery: [{ ...input.money.delivery[0], amountMinor: 1 }],
    };
    const unsafe = { ...input, money };
    expect(() => makeTaxQuoteRequest("key", unsafe)).toThrow(expect.objectContaining({
      code: "tax_amount_out_of_range", field: "/money",
    }));
    const envelope = { key: "key", input: unsafe, inputDigest: taggedDigest("input", unsafe) };
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
    expect(verifyTaxQuoteRequest(altered)).toEqual(conflict("/inputDigest"));
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
    requestKey: request.key, scope, calculationRef: "calculation-a", status: "final", calculatedAt: date, expiresAt: later,
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
    const { requestKey: _key, ...unbound } = receipt;
    refuses(() => taxCalculationEvidenceV1Schema.parse(unbound), "/requestKey");
    refuses(() => taxCalculationEvidenceV1Schema.parse({ ...receipt, requestKey: "" }), "/requestKey");
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
    expect(verify({ ...receipt, requestKey: undeclared.key, inputDigest: undeclared.inputDigest }, undeclared)).toMatchObject({
      code: "tax_reference_conflict", field: "/evidence/coverage/vector/0/declaration",
    });
    const incomplete = vector.filter(row => row.cell.target.key !== "item-a");
    expect(verify(bindFiscal({ ...receipt, coverage: { vector: incomplete, digest: taggedDigest("coverage", incomplete) } }))).toMatchObject({
      code: "tax_reference_conflict", field: "/evidence/coverage/vector",
    });
    const tax = receipt.positions.tax[0];
    const wrongResolution = { ...tax.resolution, assignmentRef: "unknown" };
    const wrongAssignment = { ...tax, resolution: wrongResolution, resolutionDigest: taggedDigest("resolution", wrongResolution) };
    expect(verify(bindFiscal({ ...receipt, positions: { ...receipt.positions, tax: [wrongAssignment] } }))).toMatchObject({
      code: "tax_reference_conflict", field: "/evidence/positions/tax/0/resolution/assignmentRef",
    });
  });

  it("verifies successful quote digests, status and request bindings", () => {
    const result = successful();
    expect(verifyTaxQuoteResult(request, result)).toBeUndefined();
    const estimateRequest = makeTaxQuoteRequest("estimate", { ...request.input, purpose: "estimate" });
    const estimate = { ...receipt, status: "estimate" as const, requestKey: estimateRequest.key, inputDigest: estimateRequest.inputDigest };
    expect(verifyTaxQuoteResult(estimateRequest, {
      kind: "estimate", money, evidence: estimate, evidenceDigest: taggedDigest("evidence", estimate),
    })).toBeUndefined();
    const wrongStatus = { ...estimate, requestKey: request.key, inputDigest: request.inputDigest };
    const wrongResult = { ...result, evidence: wrongStatus, evidenceDigest: taggedDigest("evidence", wrongStatus) };
    expect(verifyTaxQuoteResult(request, wrongResult as unknown as TaxQuoteResultV1)).toMatchObject({
      code: "tax_reference_conflict", field: "/evidence/status",
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
      expect(verifyTaxQuoteResult(request, successful(bindFiscal(rebound)))).toMatchObject({ code: "tax_reference_conflict", field });
    }
  });

  it("identical_inputs_under_two_keys_refused", () => {
    const { input, evidence, validity } = structuredClone({ input: request.input, evidence: receipt, validity: fiscal });
    const first = makeTaxQuoteRequest("quote-a", input);
    const second = makeTaxQuoteRequest("quote-b", input);
    expect(second.key).not.toBe(first.key);
    expect(second.inputDigest).toBe(first.inputDigest);

    const result = successful({ ...evidence, requestKey: first.key });
    const originalValidity = { ...validity, original: first, evidence: result.evidence, evidenceDigest: result.evidenceDigest };
    expect(verifyTaxQuoteResult(first, result)).toBeUndefined();
    expect(verifyTaxQuoteRequest(originalValidity)).toBeUndefined();

    const replay = conflict("/evidence/requestKey");
    expect(verifyTaxQuoteResult(second, structuredClone(result))).toEqual(replay);
    expect(verifyTaxQuoteRequest({ ...structuredClone(originalValidity), original: second })).toEqual(replay);

    const relabeled = { ...result.evidence, requestKey: second.key };
    expect(fiscalHash(relabeled)).toBe(result.evidence.fiscalDigest);
    expect(verifyTaxQuoteResult(second, { ...result, evidence: relabeled }))
      .toEqual(conflict("/evidenceDigest"));
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
      remedy: remedies.tax_breakdown_incomplete,
    });
    const moneyOnlyRate = localMoney(request.input.money, "district-a", "99");
    expectRefusal(verifyTaxQuoteResult(request, { ...result, money: moneyOnlyRate }),
      "tax_breakdown_incomplete", "/evidence/positions/tax/0/ratePercent");
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
        ...receipt, requestKey: original.key, inputDigest: original.inputDigest, coverage: { vector: coverage.vector, digest: coverage.digest },
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

  const expectReplay = (original: TaxQuoteRequestV1, result: ReturnType<typeof successful>, field: string) => {
    const refusal = conflict(field);
    expect(verifyTaxQuoteResult(original, result)).toEqual(refusal);
    expect(verifyTaxQuoteRequest({ ...structuredClone(fiscal), original,
      evidence: result.evidence, evidenceDigest: result.evidenceDigest })).toEqual(refusal);
  };

  it("input_changed_document_with_recomputed_digest_refuses", () => {
    const { original, result } = structuredClone({ original: request, result: successful() });
    const input = { ...original.input, currency: "XTS" };
    const changed = { ...original, input, inputDigest: taggedDigest("input", input) };
    expect(changed.inputDigest).not.toBe(result.evidence.inputDigest);
    expectReplay(changed, result, "/evidence/inputDigest");
  });

  it("resolution_changed_document_with_recomputed_digest_refuses", () => {
    const { original, result } = structuredClone({ original: request, result: successful() });
    const [position] = result.evidence.positions.tax;
    const originalResolution = { ...position.resolution, effective: { ...position.resolution.effective, until: later } };
    const sealed = bindFiscal({ ...result.evidence, positions: { ...result.evidence.positions, tax: [{
      ...position, resolution: originalResolution, resolutionDigest: taggedDigest("resolution", originalResolution),
    }] } });
    const sealedResult = { ...result, evidence: { ...sealed, status: "final" as const }, evidenceDigest: taggedDigest("evidence", sealed) };
    expect(verifyTaxQuoteResult(original, sealedResult)).toBeUndefined();

    const resolution = { ...originalResolution, policyRevision: "different-policy",
      effective: { ...originalResolution.effective, until: "2030-03-01T00:00:00.000Z" } };
    const changedPosition = { ...sealed.positions.tax[0], resolution };
    const changed = { ...sealedResult.evidence, positions: { ...sealed.positions, tax: [changedPosition] } };
    expectReplay(original, { ...sealedResult, evidence: changed, evidenceDigest: taggedDigest("evidence", changed) },
      "/evidence/positions/tax/0/resolutionDigest", "rule resolution");

    const rehashed = { ...changed, positions: { ...changed.positions,
      tax: [{ ...changedPosition, resolutionDigest: taggedDigest("resolution", resolution) }] } };
    expectReplay(original, { ...sealedResult, evidence: rehashed }, "/evidence/fiscalDigest");
  });

  it("coverage_changed_document_with_recomputed_digest_refuses", () => {
    const { original, result } = structuredClone({ original: request, result: successful() });
    const [row, ...remaining] = result.evidence.coverage.vector;
    const vector = [{ ...row, treatment: { ...taxable, reason: "different-reason" } }, ...remaining];
    const evidence = { ...result.evidence, coverage: { vector, digest: taggedDigest("coverage", vector) } };
    expectReplay(original, { ...result, evidence }, "/evidence/fiscalDigest");
  });

  it("fiscal_changed_document_with_recomputed_digest_refuses", () => {
    const { original, result } = structuredClone({ original: request, result: successful() });
    const changed = { ...result.evidence, classMapRevision: "different-classes" };
    const evidence = { ...changed, fiscalDigest: fiscalHash(changed) };
    expectReplay(original, { ...result, evidence }, "/evidenceDigest");
  });

  it("evidence_changed_document_with_recomputed_digest_refuses", () => {
    const { result, validity } = structuredClone({ result: successful(), validity: fiscal });
    const evidence = { ...result.evidence, expiresAt: "2030-03-01T00:00:00.000Z" };
    const changed = { ...result, evidence, evidenceDigest: taggedDigest("evidence", evidence) };
    expect(changed.evidenceDigest).not.toBe(validity.evidenceDigest);
    const refusal = conflict("/evidenceDigest");
    expect(verifyTaxQuoteRequest({ ...validity, evidence: changed.evidence })).toEqual(refusal);
    expect(verifyTaxQuoteResult(validity.original, { ...changed, evidenceDigest: validity.evidenceDigest })).toEqual(refusal);
  });

  const coverageFor = (original: TaxQuoteRequestV1) => reconcileTaxCoverage({
    scope, taxDate: date, coverage: original.input.coverage, required: original.input.required,
    observations: original.input.required.map(cell => ({ cell, registration: active, treatment: taxable, assessedMinor: 0 })),
  }).vector;
  const resultWith = (original: TaxQuoteRequestV1, assessment = money, evidence = receipt, rows = evidence.coverage.vector) => {
    const bound = bindFiscal({
      ...evidence, status: original.input.purpose, requestKey: original.key, inputDigest: original.inputDigest,
      coverage: { vector: rows, digest: taggedDigest("coverage", rows) },
    });
    return { kind: bound.status, money: assessment, evidence: bound, evidenceDigest: taggedDigest("evidence", bound) } as TaxQuoteResultV1;
  };

  const checks = (result: TaxQuoteResultV1, original = request, current = fiscal.current) => {
    if (result.kind !== "final" && result.kind !== "estimate") throw new Error("Expected calculation evidence.");
    return [
      verifyTaxQuoteResult(original, result),
      verifyTaxQuoteRequest({ ...fiscal, original, current, evidence: result.evidence, evidenceDigest: result.evidenceDigest }),
    ];
  };
  const unsafeResult = { ...money, payableMinor: Number.MAX_SAFE_INTEGER + 1 };
  const unsafeInput = (input: TaxQuoteRequestV1["input"]) => ({ ...input, money: {
    ...input.money, sources: [{ ...input.money.sources[0], unitBasisMinor: Number.MAX_SAFE_INTEGER + 1 }, ...input.money.sources.slice(1)],
  } });
  const [taxRow] = receipt.positions.tax;
  const [feeRow] = receipt.positions.fees;
  const withTax = (row: typeof taxRow) => ({ ...receipt, positions: { ...receipt.positions, tax: [row] } });
  const withFee = (row: typeof feeRow) => ({ ...receipt, positions: { ...receipt.positions, fees: [row] } });

  it("coupled_tax_metadata_requires_original_breakdown", () => {
    const evidence = bindFiscal(withTax({ ...taxRow, cell: cell("item-a"), ruleRef: "other-rule",
      resolution: { ...taxRow.resolution, assignmentRef: "other-assignment" },
      resolutionDigest: taggedDigest("resolution", { ...taxRow.resolution, assignmentRef: "other-assignment" }),
    }));
    expect(verifyTaxQuoteResult(request, successful(evidence))).toEqual(breakdown("/evidence/positions/tax/0"));
    expect(verifyTaxQuoteResult(request, successful())).toBeUndefined();
  });

  it("multi_coordinate_fee_requires_original_breakdown", () => {
    const changed = withFee({ ...feeRow, jurisdiction: "district-b", feeKind: "other-fee", scope: { kind: "order" },
      refundRule: { ref: "other-refund", revision: "2" },
    });
    expect(verifyTaxQuoteResult(request, successful(bindFiscal(changed)))).toEqual(breakdown("/evidence/positions/fees/0"));
    const original = successful();
    expect(original.evidence.positions.fees[0].refundRule).toEqual(feeRow.refundRule);
    expect(verifyTaxQuoteResult(request, original)).toBeUndefined();
  });

  it("ambiguous_tax_kind_requires_original_breakdown", () => {
    const second = { ...taxRow.cell, taxKind: "second-kind" };
    const original = makeTaxQuoteRequest(request.key, { ...request.input, required: [...request.input.required, second],
      coverage: { ...request.input.coverage, declarations: [...request.input.coverage.declarations, { ...registered(), taxKind: second.taxKind }] },
    });
    const rows = coverageFor(original);
    const correct = resultWith(original, money, withTax({ ...taxRow, cell: second }), rows);
    const changed = resultWith(original, money, withTax({ ...taxRow, cell: { ...second, taxKind: "unknown-kind" } }), rows);
    expect(verifyTaxQuoteResult(original, changed)).toEqual(breakdown("/evidence/positions/tax/0/cell"));
    expect(verifyTaxQuoteResult(original, correct)).toBeUndefined();
  });

  it("stale_digests_precede_unsafe_money", () => {
    const stale = successful(withTax({ ...taxRow, resolutionDigest: "b".repeat(64) }));
    expect(verifyTaxQuoteResult(request, { ...stale, money: unsafeResult })).toEqual(conflict("/evidence/positions/tax/0/resolutionDigest"));
    expect(verifyTaxQuoteRequest({ ...fiscal, evidenceDigest: "b".repeat(64), current: unsafeInput(fiscal.current) }))
      .toEqual(conflict("/evidenceDigest"));
    expect(verifyTaxQuoteResult(request, { ...successful(), money: unsafeResult })).toMatchObject({ field: "/money/payableMinor" });
    expect(verifyTaxQuoteRequest({ ...fiscal, current: unsafeInput(fiscal.current) }))
      .toMatchObject({ field: "/current/money/sources/0/unitBasisMinor" });
    expect(checks(successful())).toEqual([undefined, undefined]);
  });

  it("stale_resolution_precedes_interval_order", () => {
    const evidence = withTax({ ...taxRow, resolution: { ...taxRow.resolution, effective: { from: later, until: date } } });
    expect(checks(successful(evidence))).toEqual(Array(2).fill(conflict("/evidence/positions/tax/0/resolutionDigest")));
    expect(checks(successful())).toEqual([undefined, undefined]);
  });

  const { resolutionDigest: _resolutionDigest, ...noResolutionDigest } = taxRow;
  const { requestKey: _requestKey, ...noRequestKey } = receipt;
  it.each([
    ["absent outer", "/evidenceDigest", { ...receipt, expiresAt: "2030-03-01T00:00:00.000Z" }, undefined, true],
    ["malformed outer", "/evidenceDigest", { ...receipt, expiresAt: "2030-03-01T00:00:00.000Z" }, "bad", true],
    ["wrong-typed outer", "/evidenceDigest", { ...receipt, expiresAt: "2030-03-01T00:00:00.000Z" }, 5, true],
    ["absent resolution", "/evidence/positions/tax/0/resolutionDigest", withTax(noResolutionDigest as typeof taxRow)],
    ["wrong-typed resolution", "/evidence/positions/tax/0/resolutionDigest", withTax({ ...taxRow, resolutionDigest: 5 as unknown as string })],
    ["absent echo", "/evidence/requestKey", noRequestKey],
    ["wrong-typed echo", "/evidence/policyRevision", bindFiscal({ ...receipt, policyRevision: 5 as unknown as string })],
    ["wrong-typed source digest", "/evidence/positions/tax/0/resolution/sourceDigest",
      bindFiscal(withTax({ ...taxRow, resolution: { ...taxRow.resolution, sourceDigest: 5 as unknown as string },
        resolutionDigest: taggedDigest("resolution", { ...taxRow.resolution, sourceDigest: 5 }) }))],
  ] as const)("missing_or_malformed_anchor_requires_replay (%s)", (_name, field, value, outer, override) => {
    const result = successful(value as TaxCalculationEvidenceV1);
    const verify = (document: typeof result) => verifyTaxQuoteResult(request, document);
    if (!override) expect(checks(result)).toEqual(Array(2).fill(conflict(field)));
    else {
      const { evidenceDigest: _digest, ...withoutDigest } = result;
      const { evidenceDigest: _validityDigest, ...withoutValidityDigest } = fiscal;
      expect(verify((outer === undefined ? withoutDigest : { ...withoutDigest, evidenceDigest: outer }) as typeof result)).toEqual(conflict(field));
      expect(verifyTaxQuoteRequest({ ...withoutValidityDigest, evidence: result.evidence,
        ...(outer !== undefined && { evidenceDigest: outer }),
      } as typeof fiscal)).toEqual(conflict(field));
    }
    expect(checks(successful())).toEqual([undefined, undefined]);
  });

  it("foreign_evidence_requires_matching_pair", () => {
    const otherAccount = { ...scope, accountRef: "other-account" };
    for (const [foreign, evidence, field] of [
      [makeTaxQuoteRequest(request.key, { ...request.input, currency: "XTS" }), receipt, "/evidence/inputDigest"],
      [makeTaxQuoteRequest("foreign-key", request.input), receipt, "/evidence/requestKey"],
      [makeTaxQuoteRequest(request.key, { ...request.input, scope: otherAccount,
        coverage: { ...request.input.coverage, accountRef: otherAccount.accountRef } }), { ...receipt, scope: otherAccount }, "/evidence/inputDigest"],
    ] as const) {
      const foreignPair = resultWith(foreign, localMoney(foreign.input.money), evidence);
      expect(checks(foreignPair, foreign, { ...foreign.input, taxDate: later })).toEqual([undefined, undefined]);
      expect(checks(foreignPair)).toEqual(Array(2).fill(conflict(field)));
      expect(checks(successful())).toEqual([undefined, undefined]);
    }
  });

  it("foreign_key_precedes_unsafe_result", () => {
    const original = makeTaxQuoteRequest("foreign-key", request.input);
    const foreign = successful({ ...receipt, requestKey: original.key });
    expect(verifyTaxQuoteResult(original, foreign)).toBeUndefined();
    expect(verifyTaxQuoteResult(request, { ...foreign, money: unsafeResult })).toEqual(conflict("/evidence/requestKey"));
    expect(verifyTaxQuoteResult(request, { ...successful(), money: unsafeResult })).toMatchObject({ field: "/money/payableMinor" });
  });

  it("coverage_bindings_precede_money", () => {
    const wrongActor = { ...vector[1], declaration: { ...vector[1].declaration!, actorRef: "other" } };
    for (const [rows, pointer] of [
      [[vector[0], wrongActor, ...vector.slice(2)], "/evidence/coverage/vector/1/declaration"],
      [vector.slice(1), "/evidence/coverage/vector"],
      [[{ ...vector[0], decision: "undeclared" as const }, wrongActor, ...vector.slice(2)], "/evidence/coverage/vector/1/declaration"],
    ] as const) {
      expect(checks(resultWith(request, unsafeResult, receipt, rows), request, unsafeInput(fiscal.current)))
        .toEqual(Array(2).fill(conflict(pointer)));
    }
    expect(checks({ ...successful(), money: unsafeResult }, request, unsafeInput(fiscal.current))).toMatchObject([
      { field: "/money/payableMinor" }, { field: "/current/money/sources/0/unitBasisMinor" },
    ]);
    expect(checks(successful())).toEqual([undefined, undefined]);
  });

  it("checks raw digests and refuses documents with accessors at snapshot", () => {
    const input = { ...request.input, unknownField: "held by digest" };
    expectRefusal(verifyTaxQuoteRequest({ ...request, input }), "tax_reference_conflict", "/inputDigest");
    expectRefusal(verifyTaxQuoteRequest({ ...request, input, inputDigest: taggedDigest("input", input) }), "tax_invalid_input", "/input");
    let reads = 0;
    const address = { ...input.destination.address, get line1() { reads++; return "unreadable"; } };
    const inaccessible = { ...request, input: { ...request.input, destination: { ...input.destination, address } } };
    const foreign = successful({ ...receipt, requestKey: "other-key" });
    expectRefusal(verifyTaxQuoteResult(inaccessible, foreign), "tax_reference_conflict", "");
    expectRefusal(verifyTaxQuoteResult(inaccessible, successful()), "tax_reference_conflict", "");
    expect(reads).toBe(2); // Each failed canonical snapshot measures the JSON size.
    expectRefusal(verifyTaxQuoteResult(request, { ...successful(), evidence: new Date() } as unknown as TaxQuoteResultV1),
      "tax_reference_conflict", "/evidence");
  });

  it("binds the optional provider lines on both verification paths", () => {
    const providerLines = request.input.lines.map(({ lineKey }) => ({ lineKey, providerLineRef: lineKey === "item-z" ? "provider-line-a" : "provider-line-b" }));
    const result = successful({ ...receipt, providerLines });
    expect(checks(result)).toEqual([undefined, undefined]);
    const changed = { ...result.evidence, providerLines: providerLines.slice(1) };
    expect(checks({ ...result, evidence: changed })).toEqual(Array(2).fill(conflict("/evidenceDigest")));
    expect(checks(successful(changed))).toEqual(Array(2).fill(conflict("/evidence/providerLines")));
  });

  const wrapped = <T extends object>(value: T): T => new Proxy(value, {});
  const foreignAccount = { ...request.input, coverage: { ...request.input.coverage, accountRef: "other-account" } };
  const foreignEvidence = successful({ ...receipt, requestKey: "other-key" });
  const foreignCurrent = { ...fiscal.current, scope: { ...scope, mode: "live" as const } };
  it.each([
    ["quote request with a stale digest", () => verifyTaxQuoteRequest(wrapped({ ...request, inputDigest: digest })), "/inputDigest"],
    ["quote request for a foreign account", () => verifyTaxQuoteRequest(wrapped({ ...request,
      input: foreignAccount, inputDigest: taggedDigest("input", foreignAccount),
    })), "/input/coverage/accountRef"],
    ["quote result with a stale digest", () => verifyTaxQuoteResult(request, wrapped({ ...successful(), evidenceDigest: digest })), "/evidenceDigest"],
    ["quote result from a foreign key", () => verifyTaxQuoteResult(request, wrapped(foreignEvidence)), "/evidence/requestKey"],
    ["fiscal original with a stale digest", () => verifyTaxQuoteRequest({ ...fiscal,
      original: wrapped({ ...request, inputDigest: digest }),
    }), "/original/inputDigest"],
    ["fiscal original under a foreign key", () => verifyTaxQuoteRequest({ ...fiscal,
      original: wrapped({ ...request, key: "other-key" }),
    }), "/evidence/requestKey"],
    ["fiscal current in a foreign mode", () => verifyTaxQuoteRequest({ ...fiscal, current: wrapped(foreignCurrent) }), "/current/scope"],
  ] as const)("checks integrity on a wrapped %s", (_name, verify, pointer) => {
    expectRefusal(verify(), "tax_reference_conflict", pointer);
  });

  it("verifies valid wrapper objects as their plain snapshots", () => {
    expect(verifyTaxQuoteRequest(wrapped(request))).toBeUndefined();
    const required = [...request.input.required];
    Object.setPrototypeOf(required, Object.create(Array.prototype));
    expect(verifyTaxQuoteRequest({ ...request, input: { ...request.input, required } })).toBeUndefined();
    expect(verifyTaxQuoteResult(wrapped(request), wrapped(successful()))).toBeUndefined();
    expect(verifyTaxQuoteRequest(wrapped({ ...fiscal, original: wrapped(request), current: wrapped(fiscal.current) }))).toBeUndefined();
  });

  it("uses phase-specific remedies for a coverage account mismatch", () => {
    const foreign = { ...request, input: foreignAccount, inputDigest: taggedDigest("input", foreignAccount) };
    const code = "tax_scope_mismatch";
    const message = "Supply coverage evidence for the selected account";
    expect(() => makeTaxQuoteRequest(request.key, foreignAccount)).toThrow(expect.objectContaining({
      code, field: "/coverage/accountRef", message,
    }));
    expect(() => taxQuoteRequestV1Schema.parse(foreign)).toThrow(expect.objectContaining({
      code, field: "/input/coverage/accountRef", message,
    }));
    expectRefusal(verifyTaxQuoteRequest(foreign), "tax_reference_conflict", "/input/coverage/accountRef");
  });

  it("verifies a fiscal envelope at its canonical byte limit", () => {
    const declarations = [...fiscal.current.coverage.declarations];
    const current = { ...fiscal.current, coverage: { ...fiscal.current.coverage, declarations } };
    const envelope = { ...fiscal, current };
    const sample = { ...registered("x".repeat(256)), actorRef: "x" };
    const rowBytes = Buffer.byteLength(JSON.stringify(sample)) + 1;
    const available = CATALOG_DRAFT_MAX_BYTES - Buffer.byteLength(JSON.stringify(envelope));
    const count = Math.floor(available / rowBytes);
    let remaining = available % rowBytes;
    for (let index = 0; index < count; index++) {
      const extra = Math.min(remaining, 255);
      declarations.push({ ...sample, jurisdiction: String(index).padEnd(256, "x"), actorRef: "x".repeat(1 + extra) });
      remaining -= extra;
    }
    expect(Buffer.byteLength(canonicalCatalogDraftJson(envelope))).toBe(CATALOG_DRAFT_MAX_BYTES);
    expect(verifyTaxQuoteRequest(envelope)).toBeUndefined();
  });

  it("checks the evidence digest anchor when evidence is absent or undefined", () => {
    const { evidence: _evidence, ...withoutEvidence } = fiscal;
    const { evidence: _quoteEvidence, ...withoutQuoteEvidence } = successful();
    for (const envelope of [withoutEvidence, { ...withoutEvidence, evidence: undefined }]) {
      expectRefusal(verifyTaxQuoteRequest(envelope as typeof fiscal), "tax_reference_conflict", "/evidenceDigest");
      expectRefusal(verifyTaxQuoteRequest({ ...envelope, original: { ...request, inputDigest: digest } } as typeof fiscal),
        "tax_reference_conflict", "/original/inputDigest");
    }
    for (const result of [withoutQuoteEvidence, { ...withoutQuoteEvidence, evidence: undefined }]) {
      expectRefusal(verifyTaxQuoteResult(request, result as TaxQuoteResultV1), "tax_reference_conflict", "/evidenceDigest");
    }
  });

  it("measures failed snapshots without relying on the thrown message", () => {
    const wrapped = new Proxy(request, {
      getPrototypeOf() { throw new Error("draft_payload_too_large"); },
    });
    expect(Buffer.byteLength(JSON.stringify(wrapped))).toBeLessThan(CATALOG_DRAFT_MAX_BYTES);
    expectRefusal(verifyTaxQuoteRequest(wrapped), "tax_reference_conflict", "");

    const cycle = { ...request, self: {} };
    cycle.self = cycle;
    expectRefusal(verifyTaxQuoteRequest(cycle), "tax_reference_conflict", "");
  });

  it("compares a successful kind to the request purpose without evidence", () => {
    const { evidence: _evidence, evidenceDigest: _digest, ...result } = successful();
    expectRefusal(verifyTaxQuoteResult(request, { ...result, kind: "estimate" } as TaxQuoteResultV1), "tax_reference_conflict", "/kind");
  });

  it("partial_documents_preserve_integrity_checks", () => {
    const required = [{ ...request.input.required[0], taxKind: 1 as unknown as string }, ...request.input.required.slice(1)];
    const incomplete = { ...request, input: { ...request.input, required } };
    expect(verifyTaxQuoteRequest({ ...incomplete, input: { ...incomplete.input,
      coverage: { ...request.input.coverage, accountRef: "another-account" },
    } })).toEqual(conflict("/input/coverage/accountRef"));
    expectRefusal(verifyTaxQuoteRequest(incomplete), "tax_reference_conflict", "/inputDigest");
    expectRefusal(verifyTaxQuoteRequest({ ...incomplete, inputDigest: taggedDigest("input", incomplete.input) }),
      "tax_invalid_input", "/input/required/0/taxKind");

    const malformed = { ...successful({ ...receipt, requestKey: "another-key" }), kind: 1 };
    expect(verifyTaxQuoteResult(request, malformed as unknown as TaxQuoteResultV1)).toEqual(conflict("/evidence/requestKey"));
    expect(verifyTaxQuoteResult(request, { ...successful(), kind: malformed.kind } as unknown as TaxQuoteResultV1)).toEqual(conflict("/kind"));

    const { adapterVersion: _adapterVersion, ...scopeWithoutVersion } = fiscal.current.scope;
    const checkScope = (mode: typeof scope.mode) => verifyTaxQuoteRequest({
      ...fiscal, current: { ...fiscal.current, scope: { ...scopeWithoutVersion, mode } as typeof scope },
    });
    expect(checkScope("live")).toEqual(conflict("/current/scope"));
    expect(checkScope(scope.mode)).toEqual(conflict("/current/scope/adapterVersion"));

    const input = unsafeInput(request.input);
    const rebound = { ...request, input, inputDigest: taggedDigest("input", input) };
    const stale = { ...rebound, inputDigest: request.inputDigest };
    expect(verifyTaxQuoteRequest(stale)).toEqual(conflict("/inputDigest"));
    expect(verifyTaxQuoteResult(stale, successful())).toEqual(conflict("/inputDigest"));
    expect(verifyTaxQuoteRequest({ ...fiscal, original: stale })).toEqual(conflict("/original/inputDigest"));
    expect(verifyTaxQuoteRequest(rebound)).toMatchObject({ field: "/input/money/sources/0/unitBasisMinor" });
    expect(checks(successful({ ...receipt, inputDigest: rebound.inputDigest }), rebound)).toMatchObject([
      { field: "/input/money/sources/0/unitBasisMinor" }, { field: "/original/input/money/sources/0/unitBasisMinor" },
    ]);
  });

  it("verifier_refusal_contract", () => {
    type Success = Extract<TaxQuoteResultV1, { kind: "final" | "estimate" }>;
    type Example = { original: TaxQuoteRequestV1; result: Success };
    type Edit = readonly [path: string, value: unknown];
    type Probe = {
      field: string; code: Code;
      broken: readonly Edit[]; base?: Example; shared?: boolean; stale?: Edit;
    };
    const example = (original = request, result = resultWith(original)): Example => {
      if (result.kind !== "final" && result.kind !== "estimate") throw new Error("Expected calculation evidence.");
      return { original, result };
    };
    const edit = (document: Example, [path, value]: Edit) => {
      const keys = path.slice(1).split("/");
      const key = keys.pop()!;
      const parent = keys.reduce((node, key) => (node as Record<string, unknown>)[key], document as unknown);
      if (Array.isArray(parent) && value === undefined) parent.splice(Number(key), 1);
      else if (value === undefined) delete (parent as Record<string, unknown>)[key];
      else (parent as Record<string, unknown>)[key] = structuredClone(value);
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

      const { evidence } = result;
      const hash = (path: string, digest: string) => edit(document, [path, stale?.[0] === path ? stale[1] : digest]);
      hash("/original/inputDigest", taggedDigest("input", original.input));
      evidence.positions.tax.forEach((position, index) =>
        hash("/result/evidence/positions/tax/" + index + "/resolutionDigest", taggedDigest("resolution", position.resolution)));
      hash("/result/evidence/coverage/digest", taggedDigest("coverage", evidence.coverage.vector));
      hash("/result/evidence/fiscalDigest", fiscalHash(evidence));
      hash("/result/evidenceDigest", taggedDigest("evidence", evidence));
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

    const editField = (code: Code, field: string, value: unknown, options: Partial<Probe> = {}): Probe =>
      ({ code, field, broken: [["/result" + field, value]], ...options });
    const assessment = (field: string, value: unknown, options?: Partial<Probe>) =>
      editField("tax_breakdown_incomplete", field, value, options);
    const binding = (field: string, value: unknown, options?: Partial<Probe>) =>
      editField("tax_reference_conflict", field, value, { shared: true, ...options });
    const stale = (field: string, path = "/result" + field) =>
      binding(field, digest, { broken: [], stale: [path, digest] });
    const probes: Probe[] = [
      stale("/inputDigest", "/original/inputDigest"),
      ...["/evidenceDigest", "/evidence/coverage/digest", tax + "/resolutionDigest", "/evidence/fiscalDigest"].map(field => stale(field)),
      binding("/evidence/inputDigest", digest),
      binding("/evidence/destinationDigest", "b".repeat(64)),
      ...Object.entries({
        scope: { ...scope, adapterVersion: "2" }, requestKey: "other-key", taxDate: "2030-01-02T00:00:00.000Z",
        shipFromRef: "different-origin", policyRevision: "different-policy", classMapRevision: "different-classes",
      }).map(([field, value]) => binding("/evidence/" + field, value)),
      binding("/evidence/status", "estimate"),
      binding("/kind", "estimate", { shared: false }),
      binding("/evidence/coverage/vector", vector.filter((_, i) => i !== rowIndex)),
      binding("/evidence/coverage/vector", vector[0], { broken: [["/result/evidence/coverage/vector/1", vector[0]]] }),
      binding(covered + "/declaration", { ...vector[rowIndex].declaration, actorRef: "other" }),
      binding(covered + "/declaration", { ...vector[rowIndex].declaration, jurisdiction: "other" }),
      ...["undeclared", "in_scope_exempt"].map(value =>
        editField("tax_calculation_unusable", covered + "/decision", value, { shared: true })),
      editField("tax_calculation_unusable", covered + "/decision", "undeclared", { base: estimate, shared: true }),
      editField("tax_invalid_input", covered + "/registration", { ...active, effective: { from: later } }, { shared: true }),
      editField("tax_invalid_input", "/evidence/expiresAt", date, { shared: true }),
      editField("tax_invalid_input", tax + "/resolution/effective", { from: later }, { shared: true }),
      binding(tax + "/resolution/assignmentRef", "other-assignment"),
      binding(tax + "/resolution/policyRevision", "other-policy"),
      binding(tax + "/ruleRef", "other-rule"),
      assessment(position + "/jurisdictionRef", "district-b"),
      assessment(moneyFee + "/feeKey", "other-fee"),
      assessment("/money/components/1/initial/taxPositions/0/positionRef", "item-z", { base: distinct }),
      assessment(position + "/positionRef", undefined, { broken: [["/result" + tax, undefined]] }),
      assessment(moneyFee + "/feeKey", undefined, { broken: [["/result" + fee, undefined]] }),
      ...(["tax", "fees"] as const).flatMap(kind => {
        const path = "/evidence/positions/" + kind + "/1";
        const field = kind === "tax" ? "positionRef" : "feeKey";
        return [
          assessment(path, receipt.positions[kind][0], { shared: true }),
          assessment(path + "/" + field, undefined, { broken: [["/result" + path, { ...receipt.positions[kind][0], [field]: "orphan" }]] }),
        ];
      }),
      ...Object.entries({ jurisdiction: "district-b", target: cell("item-a").target, sourcing: "ship_from", level: "other", taxKind: "other" })
        .map(([key, value]) => assessment(tax + "/cell/" + key, value)),
      assessment(tax + "/cell", cell("item-a", "district-b")),
      assessment(tax + "/cell", { ...cell(), sourcing: "ship_from", level: "other" }),
      ...Object.entries({ jurisdiction: "district-b", feeKind: "sale", scope: { kind: "order" } })
        .map(([key, value]) => assessment(fee + "/" + key, value)),
      assessment(fee, { ...receipt.positions.fees[0], jurisdiction: "district-b", scope: { kind: "order" } }),
      assessment(tax + "/ratePercent", undefined),
      assessment(position + "/taxMinor", 1, { base: taxExempt }),
      assessment(moneyFee + "/amountMinor", 5, { base: feeExempt }),
      assessment(moneyFee + "/feeKey", undefined, {
        base: outOfScope, broken: [["/result" + moneyFee, zero], ["/result" + fee, receipt.positions.fees[0]]],
      }),
      assessment(moneyFee + "/feeKey", undefined, {
        base: estimate, broken: [[feeCoverage, { cell: vector[feeIndex].cell, decision: "unavailable_evidence",
          declaration: vector[feeIndex].declaration }]],
      }),
    ];

    for (const { base = example(), code, field, broken, stale, shared } of probes) {
      const changed = structuredClone(base);
      for (const change of broken) edit(changed, change);
      recompute(changed, broken, stale);
      const [quoteRefusal, fiscalRefusal] = checks(changed.result, changed.original);
      expectRefusal(quoteRefusal, code, field);
      if (shared) expectRefusal(fiscalRefusal, code, field === "/inputDigest" ? "/original/inputDigest" : field);
      if (shared) expect(checks(base.result, base.original)).toEqual([undefined, undefined]);
      else expect(verifyTaxQuoteResult(base.original, base.result)).toBeUndefined();
    }

    expectRefusal(verifyTaxQuoteResult(request, { ...successful(), money: { ...money, amountBasis: "inclusive" } }),
      "tax_scope_mismatch", "/money/amountBasis");
    const range = { ...request.input, money: { ...request.input.money, adjustments: [],
      sources: request.input.money.sources.map(row => ({ ...row, quantity: 1, unitBasisMinor: Number.MAX_SAFE_INTEGER })),
    } };
    expectRefusal(verifyTaxQuoteRequest({ ...request, input: range, inputDigest: taggedDigest("input", range) }),
      "tax_amount_out_of_range", "/input/money");
    for (const field of ["netTotal", "payableMinor"] as const) {
      expectRefusal(verifyTaxQuoteResult(request, { ...successful(), money: { ...money, [field]: 1 } }),
        "tax_breakdown_incomplete", "/money/" + field);
    }
    expectRefusal(verifyTaxQuoteResult(request, null as unknown as TaxQuoteResultV1), "tax_invalid_input", "");

    function overLimit<T extends object>(value: T): T {
      const document = { ...value, padding: "" };
      document.padding = "x".repeat(CATALOG_DRAFT_MAX_BYTES + 1 - Buffer.byteLength(JSON.stringify(document)));
      expect(Buffer.byteLength(JSON.stringify(document))).toBe(CATALOG_DRAFT_MAX_BYTES + 1);
      return document;
    }
    expectRefusal(verifyTaxQuoteRequest(overLimit(request)), "tax_invalid_input", "", sizeRemedy);
    expectRefusal(verifyTaxQuoteResult(request, { ...successful(), evidence: overLimit(receipt) } as TaxQuoteResultV1),
      "tax_invalid_input", "/evidence", sizeRemedy);
    expectRefusal(verifyTaxQuoteRequest(overLimit(fiscal)), "tax_invalid_input", "", sizeRemedy);
    const { evidence: _evidence, ...withoutEvidence } = fiscal;
    const oversizedFiscal = overLimit(withoutEvidence);
    for (const envelope of [oversizedFiscal, { ...oversizedFiscal, evidence: undefined }]) {
      expectRefusal(verifyTaxQuoteRequest(envelope as typeof fiscal), "tax_invalid_input", "", sizeRemedy);
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
          remedy: remedies.tax_breakdown_incomplete,
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
        remedy: remedies.tax_breakdown_incomplete,
      });
    }
  });

  it("diagnoses tax and fee identity on the repairable side with or without metadata", () => {
    const { tax, fees } = receipt.positions;
    const moneyFix = remedies.tax_breakdown_incomplete;
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
      kind: "refused", code: "tax_breakdown_incomplete", field: "/evidence/positions/tax/0/cell/jurisdiction", remedy: remedies.tax_breakdown_incomplete,
    });
    expect(verifyTaxQuoteResult(original, resultWith(original, result, { ...receipt, positions: { tax: [], fees } }, rows))).toEqual({
      kind: "refused", code: "tax_breakdown_incomplete", field: "/money/components/0/initial/taxPositions/0/positionRef", remedy: remedies.tax_breakdown_incomplete,
    });
    const corrected = { ...receipt, positions: { tax: [{ ...tax[0], cell: another }], fees } };
    expect(verifyTaxQuoteResult(original, resultWith(original, result, corrected, rows))).toBeUndefined();

    for (const [change, field] of [
      [{ jurisdiction: "district-b" }, "/jurisdiction"],
      [{ feeKind: "sale" }, "/feeKind"],
      [{ scope: { kind: "order" } }, "/scope"],
    ] as const) {
      const altered = { ...receipt, positions: { tax, fees: [{ ...fees[0], ...change }] } };
      expect(verifyTaxQuoteResult(request, resultWith(request, money, altered))).toEqual({
        kind: "refused", code: "tax_breakdown_incomplete", field: "/evidence/positions/fees/0" + field,
        remedy: remedies.tax_breakdown_incomplete,
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
    const remedy = remedies.tax_breakdown_incomplete;
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
          remedy: remedies.tax_calculation_unusable,
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
    ] as const) {
      expect(verifyTaxQuoteResult(request, bad as unknown as TaxQuoteResultV1)).toMatchObject({
        kind: "refused", code: field === "/kind" ? "tax_reference_conflict" : "tax_invalid_input", field,
      });
    }
    const accessor = { ...result, money: { ...money, get payableMinor() { throw new Error("Accessor must not run."); } } };
    expectRefusal(verifyTaxQuoteResult(request, accessor), "tax_reference_conflict", "");
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
