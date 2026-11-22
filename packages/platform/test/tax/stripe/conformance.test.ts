import { expect, it } from "vitest";
import { runTaxAdapterConformance } from "../../../src/tax/index.js";
import type { TaxConformanceCaseV1 } from "../../../src/tax/index.js";
import type { TaxCalculationPortV1, TaxReverseRequestV1 } from "../../../src/tax/contracts/index.js";
import { date, later } from "../fixtures.js";
import { detail, page, registration, registrationUrl, snapshot, withFee } from "./fixtures.js";
import { lifecycleFixture } from "./lifecycleFixtures.js";

function open(caseId: TaxConformanceCaseV1) {
  const posting = ["duplicate_commit", "partial_then_full", "reference_conflict"].includes(caseId);
  const f = lifecycleFixture({ single: posting });
  const { input, marketPack, client } = f;
  if (caseId === "missing_class") marketPack.taxCodes = {};
  if (caseId === "missing_rule") marketPack.origins = {};
  if (caseId === "tax_coverage_undeclared_refuses") input.coverage = { ...input.coverage, declarations: [] };
  if (caseId === "inconsistent_coverage_refuses_charge" || caseId === "out_of_scope") {
    client.registrations.list.mockResolvedValue(page(registrationUrl, []));
  }
  if (["exempt_in_scope", "out_of_scope", "mixed_coverage"].includes(caseId)) {
    const affected = caseId === "out_of_scope" ? ["district-a", "district-b"] : ["district-b"];
    const inactive = caseId !== "exempt_in_scope";
    const noTax = (district: string, amount: number) => ({ ...detail(0, amount, district), tax_rate_details: null,
      taxability_reason: inactive ? "not_collecting" : "product_exempt" });
    const row = (district: string, amount: number) => affected.includes(district)
      ? noTax(district, inactive ? 0 : amount) : detail(0, amount, district);
    marketPack.jurisdictions = marketPack.jurisdictions.map(binding => affected.includes(binding.jurisdiction)
      ? { ...binding, taxType: null } : binding);
    if (inactive) {
      input.coverage = { ...input.coverage, declarations: input.coverage.declarations.map(declaration =>
        affected.includes(declaration.jurisdiction) ? { ...declaration, status: "not_registered_acknowledged",
          acknowledgementRef: "approved" } : declaration) };
      marketPack.registrations = marketPack.registrations.map(binding => affected.includes(binding.jurisdiction)
        ? { ...binding, state: "RB" } : binding);
    }
    f.setResult(params => snapshot(params, 0, { shippingDetails: [row("district-a", 20)],
      lineDetails: line => [row(line.reference === "ol-m-1" ? "district-a" : "district-b", line.amount)] }));
  }
  if (caseId === "fee_on_free_delivery") {
    const fee = { ...withFee(f, "top_only"), amount: 25 };
    marketPack.fees = [{ ...marketPack.fees[0], refundRule: { ref: "refund-a", revision: "1" } }];
    client.registrations.list.mockResolvedValue(page(registrationUrl, [registration(), registration("reg_fee", "state_retail_delivery_fee")]));
    f.setResult(params => snapshot(params, 0, { fee, shippingDetails: [detail(0, 0)] }));
  }
  if (caseId === "unavailable") client.registrations.list.mockRejectedValue(new Error("Unreachable test provider"));
  const adapter = f.open();
  const request = f.request();
  const advance = () => {
    const chargeAt = caseId === "expiry" ? later : "2030-01-02T00:00:00.000Z";
    f.setTime(chargeAt);
    const scope = caseId === "foreign_validity_scope" ? { ...input.scope, accountRef: "other-account" } : input.scope;
    return { chargeAt, current: { ...request.input, taxDate: chargeAt, scope,
      coverage: { ...input.coverage, accountRef: scope.accountRef } } };
  };
  const port: TaxCalculationPortV1 = {
    ...adapter,
    async quote(quote) {
      const result = await adapter.quote(quote);
      if (result.kind === "final") f.accept({ request: quote, result, closed: false });
      return result;
    },
    commit(commit) {
      if (!f.reservations.has(commit.transactionRef)) f.reserveCommit(commit, 100);
      return adapter.commit(commit);
    },
    reverse(reverse: TaxReverseRequestV1) {
      if (!f.refunds.has(reverse.reversalRef)) f.reserveReverse(reverse, [{
        kind: "line", originalPositionRef: "item_0_0", postedPositionRef: "tax_line_0", taxCode: "txcd_101",
        remainingNetMinor: 100 - reverse.fromMinor, remainingTaxMinor: 0,
      }], 100);
      return adapter.reverse(reverse);
    },
  };
  return { ...f, request, advance, port };
}

it("passes every offline conformance case through the provider factory", async () => {
  const scenarios = new Map<TaxConformanceCaseV1, ReturnType<typeof open>>();
  const passed = await runTaxAdapterConformance({ open: async caseId => {
    const scenario = open(caseId);
    scenarios.set(caseId, scenario);
    return scenario;
  } });
  expect(passed).toEqual(["missing_class", "missing_rule", "tax_coverage_undeclared_refuses", "exempt_in_scope", "out_of_scope",
    "mixed_coverage", "inconsistent_coverage_refuses_charge", "fee_on_free_delivery", "rate_change", "expiry",
    "foreign_validity_scope", "local_close", "reference_conflict", "unavailable", "duplicate_commit", "partial_then_full"]);
  for (const scenario of scenarios.values()) {
    expect(scenario.client.calculations.retrieve).not.toHaveBeenCalled();
    expect(scenario.client.calculations.listLineItems).not.toHaveBeenCalled();
    expect(scenario.client.transactions.listLineItems).not.toHaveBeenCalled();
    expect(scenario.client.calculations.create.mock.calls.length).toBeLessThanOrEqual(1);
  }
  expect(scenarios.get("reference_conflict")?.client.transactions.createReversal.mock.calls[0][0])
    .toMatchObject({ mode: "full" });
  const remainder = scenarios.get("partial_then_full")!;
  expect(remainder.client.transactions.createReversal.mock.calls.map(([wire]) => [wire.mode, wire.line_items?.[0].amount]))
    .toEqual([["partial", -40], ["partial", -60]]);
  expect(remainder.client.transactions.retrieve).toHaveBeenCalledTimes(2);
  expect(scenarios.get("expiry")?.client.calculations.create.mock.calls[0][0].tax_date).toEqual(Date.parse(date) / 1000);
});
