import { isDeepStrictEqual } from "node:util";
import { describe, expect, it } from "vitest";
import { localRateTable, makeTaxQuoteRequest, runTaxAdapterConformance } from "../../src/tax/index.js";
import type { LocalRateTableOptionsV1, TaxConformanceCaseV1, TaxConformanceSubjectV1 } from "../../src/tax/index.js";
import type {
  TaxCalculationPort, TaxCommitRequestV1, TaxCommitResultV1, TaxQuoteInputV1, TaxRefusal, TaxReverseRequestV1, TaxReverseResultV1,
} from "../../src/tax/contracts/index.js";
import {
  date, feeInput, feeRule, exemptRule, localCutover, localInput, localOptions, localRegistration, localTime, rateRule,
} from "./fixtures.js";

type Fixture = Awaited<ReturnType<TaxConformanceSubjectV1["open"]>>;
type Defect = "wrong_key" | "refusal_with_money" | "wrong_validity" | "unsupported_effect" | "duplicate_commit" | "commit_mapping"
  | "commit_conflict" | "reversal_conflict" | "full_after_partial" | "invalid_proof_times" | "invalid_effective_from";
const postingModes = ["amount", "full"] as const;
const cleanEffects = () => ({ commits: 0, reversals: 0, providerCloses: 0 });

function localFixture(caseId: TaxConformanceCaseV1): Fixture {
  let input = localInput();
  let time = localTime;
  let options: LocalRateTableOptionsV1 = { ...localOptions(), now: () => time };
  switch (caseId) {
    case "missing_rule":
      options = { ...options, rules: [] };
      break;
    case "tax_coverage_undeclared_refuses":
      input = { ...input, coverage: { ...input.coverage, declarations: [] } };
      break;
    case "inconsistent_coverage_refuses_charge":
      options = { ...options, registrations: [{ ...localRegistration, state: "inactive" }] };
      break;
    case "unavailable":
      options = { ...options, registrations: [] };
      break;
    case "out_of_scope":
      options = { ...options, registrations: [{ ...localRegistration, state: "inactive" }] };
      input = { ...input, coverage: { ...input.coverage, declarations: [{
        ...input.coverage.declarations[0], status: "not_registered_acknowledged", acknowledgementRef: "ack-a",
      }] } };
      break;
    case "mixed_coverage": {
      const otherJurisdiction = { ...input.required[0], jurisdiction: "district-b" };
      options = { ...options, rules: [rateRule, { ...rateRule, jurisdiction: "district-b" }],
        registrations: [localRegistration, { ...localRegistration, jurisdiction: "district-b", state: "inactive" }] };
      input = { ...input, required: [input.required[0], otherJurisdiction], coverage: {
        ...input.coverage, declarations: [input.coverage.declarations[0], {
          ...input.coverage.declarations[0], jurisdiction: "district-b",
          status: "not_registered_acknowledged", acknowledgementRef: "ack-b",
        }],
      } };
      break;
    }
    case "fee_on_free_delivery":
    case "exempt_in_scope": {
      input = feeInput();
      if (caseId === "exempt_in_scope") {
        input = { ...input, required: input.required.filter(row => row.target.kind !== "fee"),
          money: { ...input.money, sources: [{ ...input.money.sources[0], unitBasisMinor: 1 }] } };
      }
      options = { ...options, rules: [{ ...rateRule, ratePercent: "0.25" }, exemptRule, feeRule],
        registrations: [localRegistration, { ...localRegistration, taxKind: "fee-a" }] };
      break;
    }
    case "rate_change":
      options = { ...options, rules: [{ ...rateRule, effective: { from: date, until: localCutover } },
        { ...rateRule, ratePercent: "2", effective: { from: localCutover } }] };
      break;
  }
  const request = makeTaxQuoteRequest(caseId, input);
  return {
    port: localRateTable(options), effects: cleanEffects,
    request: caseId === "missing_class"
      ? { ...request, input: { ...request.input, lines: [{ ...request.input.lines[0], taxClass: "" }] } } : request,
    advance() {
      time = caseId === "rate_change" ? localCutover : "2030-01-02T00:00:11.000Z";
      const scope = caseId === "foreign_validity_scope" ? { ...input.scope, accountRef: "account-b" } : input.scope;
      const current: TaxQuoteInputV1 = { ...input, scope, taxDate: time, coverage: { ...input.coverage, accountRef: scope.accountRef } };
      return { chargeAt: time, current };
    },
  };
}

function effectRefusal(code: TaxRefusal["code"]): TaxRefusal {
  return { kind: "refused", code, field: "", remedy: "Use the original effect binding and reconciled cumulative refund." };
}

function postingFixture(fixture: Fixture, modes: readonly TaxReverseRequestV1["mode"][], defect?: Defect): Fixture {
  const counts = cleanEffects();
  const sales = new Map<string, { request: TaxCommitRequestV1; result: TaxCommitResultV1 }>();
  const refunds = new Map<string, { request: TaxReverseRequestV1; result: TaxReverseResultV1 }>();
  const port: TaxCalculationPort = {
    ...fixture.port,
    capabilities: () => ({ ...fixture.port.capabilities(), posting: "provider", reversals: modes }),
    async commit(request) {
      const prior = sales.get(request.transactionRef);
      if (prior && defect !== "duplicate_commit") {
        return isDeepStrictEqual(prior.request, request) || defect === "commit_conflict"
          ? prior.result : effectRefusal("tax_reference_conflict");
      }
      const quote = await fixture.port.quote(fixture.request);
      if (quote.kind !== "final") throw new Error("Expected the fixture to return final evidence");
      const result: TaxCommitResultV1 = { kind: "committed", providerTransactionRef: request.transactionRef + "-posted",
        positions: quote.evidence.positions.tax.map(({ positionRef }) => ({
          originalPositionRef: defect === "commit_mapping" ? "other-position" : positionRef, postedPositionRef: positionRef + "-posted",
        })) };
      counts.commits++;
      sales.set(request.transactionRef, { request, result });
      return result;
    },
    async reverse(request) {
      if (!modes.includes(request.mode)) return effectRefusal("tax_operation_unsupported");
      const prior = refunds.get(request.reversalRef);
      if (prior) return isDeepStrictEqual(prior.request, request) || defect === "reversal_conflict"
        ? prior.result : effectRefusal("tax_reference_conflict");
      const result: TaxReverseResultV1 = { kind: "reversed", providerReversalRef: request.reversalRef + "-posted",
        positions: request.mode === "full" && defect === "full_after_partial"
          ? [{ ...request.positions[0], netDeltaMinor: -100 }] : request.positions };
      refunds.set(request.reversalRef, { request, result });
      counts.reversals++;
      return result;
    },
  };
  return { ...fixture, port, effects: () => ({ ...counts }) };
}

function subject(modes?: readonly TaxReverseRequestV1["mode"][], defect?: Defect): TaxConformanceSubjectV1 {
  return {
    async open(caseId) {
      const fixture = localFixture(caseId);
      if (modes) return postingFixture(fixture, modes, defect);
      const base = fixture.port;
      if (caseId === "local_close" && defect === "wrong_key") {
        fixture.port = { ...base, async quote(request) {
          return base.quote({ ...request, key: "some-other-key" });
        } };
      } else if (caseId === "unavailable" && defect === "refusal_with_money") {
        fixture.port = { ...base, async quote(request) {
          const final = await localRateTable(localOptions()).quote(request);
          return { ...final, kind: "unavailable", code: "tax_adapter_unavailable", effect: "none" };
        } };
      } else if (caseId === "foreign_validity_scope" && defect === "wrong_validity") {
        fixture.port = { ...base, async readFiscalValidity(request) {
          const result = await base.readFiscalValidity({
            ...request, current: { ...request.original.input, taxDate: request.chargeAt },
          });
          return result;
        } };
      } else if (caseId === "expiry" && (defect === "invalid_proof_times" || defect === "invalid_effective_from")) {
        fixture.port = { ...base, async readFiscalValidity(request) {
          const result = await base.readFiscalValidity(request);
          if (result.kind === "unavailable") throw new Error("Expected available validity proof");
          return { ...result, proof: {
            ...result.proof,
            observedAt: defect === "invalid_proof_times" ? "0" : result.proof.observedAt,
            effective: { ...result.proof.effective, from: "" },
          } };
        } };
      } else if (caseId === "reference_conflict" && defect === "unsupported_effect") {
        const counts = cleanEffects();
        fixture.port = { ...base, async reverse(request) { counts.reversals++; return base.reverse(request); } };
        fixture.effects = () => ({ ...counts });
      }
      return fixture;
    },
  };
}

describe("offline tax conformance", () => {
  it("qualifies all scenarios on the local adapter and the positive posting control", async () => {
    const local = await runTaxAdapterConformance(subject());
    const posting = await runTaxAdapterConformance(subject(postingModes));
    expect(local).toHaveLength(16);
    expect(posting).toEqual(local);
  });

  it.each<{ modes: readonly TaxReverseRequestV1["mode"][] }>([
    { modes: ["full"] }, { modes: ["lines"] }, { modes: ["amount"] }, { modes: [] },
  ])("qualifies a posting adapter with reversal modes $modes", async ({ modes }) => {
    await expect(runTaxAdapterConformance(subject(modes))).resolves.toHaveLength(16);
  });

  it.each<[Defect, TaxConformanceCaseV1, string, boolean]>([
    ["wrong_key", "local_close", "verifiable quote", false],
    ["refusal_with_money", "unavailable", "no calculation", false],
    ["wrong_validity", "foreign_validity_scope", "another scope", false],
    ["unsupported_effect", "reference_conflict", "zero provider closes", false],
    ["duplicate_commit", "reference_conflict", "exact effect counts", true],
    ["commit_mapping", "reference_conflict", "position mapping", true],
    ["commit_conflict", "reference_conflict", "tax_reference_conflict", true],
    ["reversal_conflict", "reference_conflict", "tax_reference_conflict", true],
    ["full_after_partial", "partial_then_full", "remaining 60", true],
    ["invalid_proof_times", "expiry", "/proof/observedAt", false],
    ["invalid_effective_from", "expiry", "/proof/effective/from", false],
  ])("catches the %s defect", async (defect, caseId, assertion, posting) => {
    await expect(runTaxAdapterConformance(subject(posting ? postingModes : undefined, defect)))
      .rejects.toThrow(new RegExp(`tax_adapter_conformance:${caseId}:.*${assertion}`));
  });
});
