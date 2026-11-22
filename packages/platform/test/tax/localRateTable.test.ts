import { describe, expect, it, vi } from "vitest";
import { CATALOG_DRAFT_MAX_BYTES } from "../../src/catalog/contracts/index.js";
import { localRateTable, makeTaxQuoteRequest, verifyTaxQuoteRequest, verifyTaxQuoteResult } from "../../src/tax/index.js";
import type { LocalRateTableOptionsV1 } from "../../src/tax/index.js";
import type { TaxQuoteResultV1 } from "../../src/tax/contracts/index.js";
import {
  active, cell, date, feeInput, feeRule, exemptRule, localCutover, localInput, localOptions, localRegistration, localTime, rateRule, withoutTaxClass,
} from "./fixtures.js";

const feeOptions = {
  ...localOptions(), rules: [rateRule, exemptRule, feeRule],
  registrations: [localRegistration, { ...localRegistration, taxKind: "fee-a" }],
};

function success(result: TaxQuoteResultV1) {
  if (result.kind !== "final" && result.kind !== "estimate") throw new Error(JSON.stringify(result));
  return result;
}

describe("local rate table", () => {
  it.each([
    { lines: 100, steps: 12, keyWidth: 56, longRefs: false },
    { lines: 150, steps: 10, keyWidth: 8, longRefs: false },
    { lines: 256, steps: 256, keyWidth: 8, longRefs: true },
  ])("verifies $lines lines with $steps order-wide adjustments", async ({ lines, steps, keyWidth, longRefs }) => {
    const input = localInput();
    const lineKeys = Array.from({ length: lines }, (_, index) => index.toString().padStart(keyWidth, "x"));
    const request = makeTaxQuoteRequest("wide-order", {
      ...input, lines: lineKeys.map(lineKey => ({ ...input.lines[0], lineKey, sku: lineKey })), required: lineKeys.map(key => cell(key)),
      money: { ...input.money,
        sources: lineKeys.map((lineKey, index) => ({ lineKey, sourceOrdinal: index + 1, quantity: 1, unitBasisMinor: 10_000 })),
        adjustments: Array.from({ length: steps }, (_, index) => ({
          adjustmentRef: String(index).padStart(longRefs ? 128 : 3, "a"),
          sequence: index + 1, amountMinor: lines, target: { lineKeys },
        })),
      },
    });
    const result = success(await localRateTable(localOptions()).quote(request));
    const { evidence, ...envelope } = result;
    const bytes = (value: unknown) => Buffer.byteLength(JSON.stringify(value));
    expect(bytes(request)).toBeLessThan(CATALOG_DRAFT_MAX_BYTES);
    expect(bytes(evidence)).toBeLessThan(CATALOG_DRAFT_MAX_BYTES);
    if (lines === 100) {
      expect(bytes(result)).toBeLessThan(CATALOG_DRAFT_MAX_BYTES);
      expect(bytes({ request, result })).toBeGreaterThan(CATALOG_DRAFT_MAX_BYTES);
    } else {
      expect(bytes(envelope)).toBeGreaterThan((longRefs ? 8 : 1) * CATALOG_DRAFT_MAX_BYTES);
    }
    expect(result.money.components).toHaveLength(lines);
    expect(result.money.components.every(component => component.allocations.length === steps)).toBe(true);
    expect(verifyTaxQuoteResult(request, result)).toBeUndefined();
  }, 60_000);

  it("uses the verified request snapshot when checking the local quote result", async () => {
    const original = makeTaxQuoteRequest("snapshot-order", localInput());
    const lines = [...original.input.lines];
    const port = localRateTable({ ...localOptions(), now: () => {
      lines[0] = { ...lines[0], taxClass: "changed-after-verification" };
      return localTime;
    } });
    const result = await port.quote({ ...original, input: { ...original.input, lines } });
    expect(result.kind).toBe("final");
    expect(verifyTaxQuoteResult(original, result)).toBeUndefined();
  });

  it.each([
    [{ rules: [rateRule, { ...rateRule, effective: { from: localCutover } }] }, "/rules/1/effective"],
    [{ registrations: [localRegistration, { ...localRegistration, effective: { from: localCutover } }] }, "/registrations/1/effective"],
    [{ rules: [{ ...rateRule, amountMinor: 0 }] }, "/rules/0"],
    [{ rules: [{ ...rateRule, ratePercent: "5e-1" }] }, "/rules/0/ratePercent"],
    [{ rules: [{ ...rateRule, ratePercent: "0.0000001" }] }, "/rules/0/ratePercent"],
    [{ rules: [{ ...rateRule, effective: { from: date, until: date } }] }, "/rules/0/effective/until"],
    [{ rules: [{ ...feeRule, refundRule: {} }] }, "/rules/0/refundRule/ref"],
    [{ rules: [{ ...feeRule, amountMinor: -1 }] }, "/rules/0/amountMinor"],
    [{ rules: [{ ...feeRule, kind: "unsupported" }] }, "/rules/0/kind"],
    [{ validityWindowMs: 0 }, "/validityWindowMs"],
  ])("rejects invalid configuration at %j", (overrides, field) => {
    expect(() => localRateTable({ ...localOptions(), ...overrides } as LocalRateTableOptionsV1))
      .toThrow(expect.objectContaining({ code: "tax_invalid_input", field }));
  });

  it("delegates discount allocation and combined exact-rate rounding across tax positions", async () => {
    const input = localInput();
    const [cell] = input.required;
    const request = makeTaxQuoteRequest("discounted-rate-example", {
      ...input, required: [cell, { ...cell, taxKind: "levy" }],
      coverage: { ...input.coverage, declarations: [input.coverage.declarations[0], { ...input.coverage.declarations[0], taxKind: "levy" }] },
      money: { ...input.money, adjustments: [{ adjustmentRef: "reduction", sequence: 7, amountMinor: 30, target: { lineKeys: [input.lines[0].lineKey] } }] },
    });
    const port = localRateTable({
      ...localOptions(),
      rules: [{ ...rateRule, ratePercent: "1.75" }, { ...rateRule, taxKind: "levy", ratePercent: "0.75" }],
      registrations: [localRegistration, { ...localRegistration, taxKind: "levy" }],
    });
    const result = success(await port.quote(request));
    expect(verifyTaxQuoteResult(request, result)).toBeUndefined();
    expect(result.money).toMatchObject({ netTotal: 70, taxTotal: 2, feeTotal: 0, payableMinor: 72 });
    expect(result.money.components[0]).toMatchObject({
      initial: { amountMinor: 100, taxMinor: 3 }, final: { amountMinor: 70, taxMinor: 2 },
      allocations: [{ sequence: 7, netReductionMinor: 30, taxReductionMinor: 1 }],
    });
    expect(result.evidence.positions.tax.map(row => row.resolution.sourceRef)).toEqual(["rulebook-a", "rulebook-a"]);
    expect(result.evidence.requestKey).toBe(request.key);
  });

  it("copies table data and returns deterministic evidence across input permutations and caller mutations", async () => {
    const request = makeTaxQuoteRequest("table-evidence", feeInput());
    const configurableFee = { ...feeRule, refundRule: { ...feeRule.refundRule, revision: "1" } };
    const configurableRate = { ...rateRule, effective: { ...rateRule.effective, from: date } };
    const port = localRateTable({ ...feeOptions, rules: [configurableFee, configurableRate, exemptRule] });
    const first = success(await port.quote(request));
    expect(first).toEqual(await localRateTable(feeOptions).quote(request));
    configurableFee.refundRule.revision = "2";
    configurableRate.effective.from = localTime;
    const feeEvidence = first.evidence.positions.fees[0].refundRule as { revision: string };
    feeEvidence.revision = "3";
    expect(await port.quote(request)).toEqual(await localRateTable(feeOptions).quote(request));
    expect(first.evidence.positions.tax[0].resolution.sourceDigest).toMatch(/^[a-f0-9]{64}$/);
  });

  it("preserves the effective proof across an unrelated table change, with separate deadline and expiry", async () => {
    const original = makeTaxQuoteRequest("timed", localInput());
    const result = success(await localRateTable(localOptions()).quote(original));
    const chargeAt = "2030-01-02T00:00:11.000Z";
    const port = localRateTable({ ...localOptions(), now: () => chargeAt,
      rules: [rateRule, { ...rateRule, taxClass: "another-class" }] });
    const validity = { original, evidence: result.evidence, evidenceDigest: result.evidenceDigest, chargeAt,
      current: { ...original.input, taxDate: chargeAt } };
    expect(chargeAt > result.evidence.expiresAt).toBe(true);
    expect(verifyTaxQuoteRequest(validity)).toBeUndefined();
    expect(await port.readFiscalValidity(validity)).toMatchObject({ kind: "unchanged", proof: {
      fiscalDigest: result.evidence.fiscalDigest, observedAt: chargeAt, dispatchBefore: "2030-01-02T00:00:13.000Z",
    } });
    expect(await port.readFiscalValidity({ ...validity, evidenceDigest: "0".repeat(64) }))
      .toMatchObject({ kind: "unavailable", effect: "none" });
    expect(await port.readFiscalValidity({ ...validity, current: {
      ...validity.current, destination: { ...validity.current.destination, snapshotRef: "replacement" },
    } })).toMatchObject({ kind: "changed" });
  });

  it("same_account_foreign_mode_requires_fresh_current", async () => {
    const original = makeTaxQuoteRequest("timed", localInput());
    const result = success(await localRateTable(localOptions()).quote(original));
    const chargeAt = "2030-01-02T00:00:11.000Z";
    const port = localRateTable({ ...localOptions(), now: () => chargeAt });
    const live = original.input.scope.mode === "test" ? "live" : "test";
    const changes = { adapter: "another-adapter", adapterVersion: "2", accountRef: "another-account", mode: live } as const;
    const validity = { original, evidence: result.evidence, evidenceDigest: result.evidenceDigest, chargeAt };
    const submit = vi.fn(port.readFiscalValidity);
    const unavailable = { kind: "unavailable", code: "tax_fiscal_validity_unavailable", effect: "none" };
    for (const [key, value] of Object.entries(changes)) {
      const scope = { ...original.input.scope, [key]: value };
      const foreign = { ...original.input, scope, taxDate: chargeAt, coverage: { ...original.input.coverage, accountRef: scope.accountRef } };
      expect(verifyTaxQuoteRequest({ ...validity, current: foreign })).toEqual({
        kind: "refused", code: "tax_reference_conflict", field: "/current/scope",
        remedy: "Replay the intended original request under its original key with its original digest and, where applicable, its matching calculation evidence and original digests. For fiscal validity, obtain fresh charge-time input from the original scope without copying or relabelling scope members.",
      });
      expect(await submit({ ...validity, current: foreign })).toEqual(unavailable);
      if (key !== "mode") continue;
      const saved = structuredClone(foreign);
      const fresh = { ...localInput(), taxDate: chargeAt };
      const obtainCurrent = vi.fn<(scope: typeof original.input.scope) => typeof fresh | undefined>()
        .mockReturnValueOnce(fresh).mockReturnValueOnce(undefined);
      const recover = async () => {
        const current = obtainCurrent(original.input.scope);
        return current === undefined ? undefined : submit({ ...validity, current });
      };
      expect(await recover()).toMatchObject({ kind: "unchanged", proof: { fiscalDigest: result.evidence.fiscalDigest } });
      expect(obtainCurrent).toHaveBeenLastCalledWith(original.input.scope);
      expect(submit.mock.lastCall?.[0].current).toBe(fresh);
      expect(foreign).toEqual(saved);
      const attempts = submit.mock.calls.length;
      expect(await recover()).toBeUndefined();
      expect(submit).toHaveBeenCalledTimes(attempts);
    }
  });

  it("ends dispatch at the first applicable interval bound and verifies a changed fee with the same refund revision", async () => {
    const original = makeTaxQuoteRequest("timed-fee", feeInput());
    const result = success(await localRateTable(feeOptions).quote(original));
    const valid = { original, evidence: result.evidence, evidenceDigest: result.evidenceDigest, chargeAt: localTime, current: original.input };
    const reconfigured = localRateTable({
      ...feeOptions, validityWindowMs: 20_000,
      rules: [...feeOptions.rules.slice(0, 2), { ...feeRule, amountMinor: 26, effective: { from: date, until: localCutover } }],
    });
    expect(await reconfigured.readFiscalValidity(valid)).toMatchObject({ kind: "changed", proof: {
      dispatchBefore: localCutover, effective: { from: date, until: localCutover },
    } });
  });

  it("reports a changed fee even when the digest and all rule references match", async () => {
    const original = makeTaxQuoteRequest("fee-replacement", feeInput());
    const rules = [{ ...exemptRule, taxClass: rateRule.taxClass }, exemptRule, feeRule];
    const result = success(await localRateTable({ ...feeOptions, rules }).quote(original));
    const reconfigured = localRateTable({ ...feeOptions,
      rules: [...rules.slice(0, 2), { ...feeRule, amountMinor: 50 }],
    });
    const updated = success(await reconfigured.quote(original));
    expect(updated.money.feeTotal).toBe(50);
    expect(updated.evidence.fiscalDigest).toBe(result.evidence.fiscalDigest);
    expect(await reconfigured.readFiscalValidity({ original, evidence: result.evidence, evidenceDigest: result.evidenceDigest,
      chargeAt: localTime, current: original.input,
    })).toMatchObject({ kind: "changed" });
  });

  it("enforces the money reference limit on assessed fee keys", async () => {
    const input = feeInput();
    const requestWithKey = (key: string) => makeTaxQuoteRequest("fee-key", { ...input,
      required: input.required.map(cell => cell.target.kind === "fee" ? { ...cell, target: { ...cell.target, key } } : cell),
    });
    const port = localRateTable(feeOptions);
    const atLimit = "a".repeat(128);
    expect(success(await port.quote(requestWithKey(atLimit))).money.fees).toEqual([{ feeKey: atLimit, amountMinor: 25 }]);
    const oversized = requestWithKey(atLimit + "a");
    expect(verifyTaxQuoteRequest(oversized)).toBeUndefined();
    const index = oversized.input.required.findIndex(cell => cell.target.kind === "fee");
    expect(await port.quote(oversized)).toEqual({ kind: "refused", code: "tax_invalid_input",
      field: `/input/required/${index}/target/key`, remedy: expect.stringContaining("128 code units"),
    });
    const exemptPort = localRateTable({ ...feeOptions,
      rules: [rateRule, exemptRule, { ...exemptRule, taxClass: feeRule.taxClass, taxKind: feeRule.taxKind }],
    });
    const exempt = await exemptPort.quote(oversized);
    expect(exempt).toMatchObject({ kind: "final", money: { fees: [] }, evidence: { positions: { fees: [] } } });
    expect(verifyTaxQuoteResult(oversized, exempt)).toBeUndefined();
  });

  it("refuses an absent free-delivery rule, a foreign scope, and a tampered request before money", async () => {
    const request = makeTaxQuoteRequest("free-delivery", feeInput());
    const port = localRateTable({ ...feeOptions, rules: [rateRule, feeRule] });
    expect(await port.quote(request)).toMatchObject({ kind: "refused", code: "tax_rule_missing", field: "/input/required/0" });
    const foreign = makeTaxQuoteRequest("foreign", { ...request.input, scope: { ...request.input.scope, mode: "live" } });
    expect(await port.quote(foreign)).toMatchObject({ kind: "refused", code: "tax_scope_mismatch" });
    expect(await port.quote({ ...foreign, inputDigest: request.inputDigest })).toMatchObject({ kind: "refused", code: "tax_reference_conflict" });
  });

  it("keeps estimates bound to their request and close stateless", async () => {
    const port = localRateTable(localOptions());
    const request = makeTaxQuoteRequest("estimate-a", { ...localInput(), purpose: "estimate" });
    const result = success(await port.quote(request));
    expect(result.kind).toBe("estimate");
    expect(verifyTaxQuoteResult(request, result)).toBeUndefined();
    expect(verifyTaxQuoteResult({ ...request, key: "different" }, result)).toMatchObject({ code: "tax_reference_conflict" });
    const ref = { scope: request.input.scope, ref: result.evidence.calculationRef, evidenceDigest: result.evidenceDigest };
    const reason = { kind: "verified_unpaid", evidenceRef: "unpaid" } as const;
    const receipt = { kind: "closed", ref, key: "close" };
    expect(await port.closeCalculation(ref, reason, "close")).toEqual(receipt);
    expect(await localRateTable(localOptions()).closeCalculation(ref, reason, "close")).toEqual(receipt);
    expect(await port.quote(request)).toEqual(result);
    const revised = makeTaxQuoteRequest(request.key, { ...request.input, purpose: "final" });
    expect(await port.quote(revised)).toMatchObject({ kind: "final", evidence: { requestKey: request.key } });
  });

  it("maps unassigned classes and unsafe money to separate refusals", async () => {
    const input = localInput();
    const missing = withoutTaxClass(makeTaxQuoteRequest("class", input));
    expect(await localRateTable(localOptions()).quote(missing)).toMatchObject({ code: "tax_class_missing", field: "/input/lines/0/taxClass" });
    const large = makeTaxQuoteRequest("large", { ...input, money: { ...input.money,
      sources: [{ ...input.money.sources[0], unitBasisMinor: Number.MAX_SAFE_INTEGER }],
    } });
    expect(await localRateTable({ ...localOptions(), rules: [{ ...rateRule, ratePercent: "1" }] }).quote(large))
      .toMatchObject({ code: "tax_amount_out_of_range" });
  });

  it("returns retryable unavailable coverage during a registration gap", async () => {
    const port = localRateTable({ ...localOptions(), registrations: [{ ...active, ...localRegistration, effective: { from: localCutover } }] });
    expect(await port.quote(makeTaxQuoteRequest("gap", localInput()))).toMatchObject({
      kind: "unavailable", code: "tax_coverage_evidence_unavailable", effect: "none",
    });
  });
});
