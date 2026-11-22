import { describe, expect, it } from "vitest";
import { verifyTaxQuoteResult } from "../../../src/tax/digest.js";
import { quoteStripeTax } from "../../../src/tax/stripe/quote.js";
import { date, later } from "../fixtures.js";
import { detail, fakeClient, fixture, now, page, registration, registrationUrl, snapshot, withFee } from "./fixtures.js";

function setup() {
  const fixtureData = fixture();
  const client = fakeClient(fixtureData.input.scope);
  const { input, marketPack, request } = fixtureData;
  const run = () => quoteStripeTax({ client, marketPack, now }, request());
  const zeroShipping = () => {
    input.money.delivery[0] = { ...input.money.delivery[0], amountMinor: 0 };
    marketPack.delivery = marketPack.delivery.map(rule => ({ ...rule, zeroAmount: false }));
  };
  return { ...fixtureData, client, run, zeroShipping };
}

const prior = "2029-01-01T00:00:00.000Z";

describe("registration inventory and tax treatments", () => {
  it("reads all statuses and uses the half-open effective interval on the tax date", async () => {
    const f = setup();
    f.client.registrations.list
      .mockResolvedValueOnce(page(registrationUrl, [registration("reg_expired", "state_sales_tax", prior, date)], true))
      .mockResolvedValueOnce(page(registrationUrl, [registration("reg_scheduled", "state_sales_tax", later), registration()]));
    const result = await f.run();
    expect(result.kind).toBe("final");
    expect(verifyTaxQuoteResult(f.request(), result)).toBeUndefined();
    if (result.kind !== "final") throw new Error("Expected a final quote.");
    expect(result.evidence.coverage.vector.map(row => row.registration?.evidenceRef)).toEqual(["reg_sale", "reg_sale", "reg_sale"]);
    expect(f.client.registrations.list.mock.calls).toEqual([[{ status: "all", limit: 100 }],
      [{ status: "all", limit: 100, starting_after: "reg_expired" }]]);
  });

  it("omits zero shipping only when qualified inventory establishes independent inactivity", async () => {
    const f = setup();
    f.zeroShipping();
    expect(await f.run()).toMatchObject({ kind: "refused", code: "tax_operation_unsupported" });
    expect(f.client.calculations.create).not.toHaveBeenCalled();
    f.input.coverage = { ...f.input.coverage, declarations: f.input.coverage.declarations.map(row =>
      ({ ...row, status: "not_registered_acknowledged", acknowledgementRef: "acknowledgement-a" })) };
    f.marketPack.jurisdictions = f.marketPack.jurisdictions.map(row => ({ ...row, taxType: null }));
    f.client.registrations.list.mockResolvedValue(page(registrationUrl,
      [registration("reg_expired", "state_sales_tax", prior, date), registration("reg_scheduled", "state_sales_tax", later)]));
    f.client.calculations.create.mockImplementation(async params => snapshot(params, 0, {
      lineDetails: line => [{ ...detail(0, 0, line.reference === "ol-m-1" ? "district-a" : "district-b"),
        tax_rate_details: null, taxability_reason: "not_collecting" }],
    }));
    const result = await f.run();
    expect(result.kind).toBe("final");
    expect(verifyTaxQuoteResult(f.request(), result)).toBeUndefined();
    if (result.kind !== "final") throw new Error("Expected a final quote.");
    expect(result.evidence.coverage.vector.map(row => row.decision)).toEqual(["out_of_scope", "out_of_scope", "out_of_scope"]);
    expect(result.money.payableMinor).toBe(200);
    expect(f.client.calculations.create.mock.calls[0][0]).not.toHaveProperty("shipping_cost");
  });

  it("refuses an unqualified discount to free shipping before transport even with acknowledged inactivity", async () => {
    const f = setup();
    f.input.coverage = { ...f.input.coverage, declarations: f.input.coverage.declarations.map(row =>
      ({ ...row, status: "not_registered_acknowledged", acknowledgementRef: "acknowledgement-a" })) };
    f.client.registrations.list.mockResolvedValue(page(registrationUrl, []));
    f.marketPack.delivery = f.marketPack.delivery.map(rule => ({ ...rule, zeroAmount: false }));
    f.input.money.adjustments = [{ adjustmentRef: "free-shipping", sequence: 1, amountMinor: 20, target: { bucketKey: "shipping-a" } }];
    expect(await f.run()).toMatchObject({
      kind: "refused", code: "tax_operation_unsupported", field: "/input/money/adjustments",
      remedy: expect.stringContaining("Qualify zero-amount shipping in the market pack"),
    });
    expect(f.client.registrations.list).not.toHaveBeenCalled();
    expect(f.client.calculations.create).not.toHaveBeenCalled();
  });

  it("reconciles zero exemption and taxable coverage in the same response", async () => {
    const f = setup();
    f.marketPack.jurisdictions = [...f.marketPack.jurisdictions,
      { ...f.marketPack.jurisdictions.find(row => row.jurisdiction === "district-b")!, taxType: null }];
    f.client.calculations.create.mockImplementation(async params => snapshot(params, 0, {
      lineDetails: line => line.reference === "ol-m-2"
        ? [{ ...detail(0, 0, "district-b"), tax_rate_details: null, taxability_reason: "product_exempt" }]
        : [detail(10, line.amount)],
    }));
    const result = await f.run();
    expect(result.kind).toBe("final");
    expect(verifyTaxQuoteResult(f.request(), result)).toBeUndefined();
    if (result.kind !== "final") throw new Error("Expected a final quote.");
    expect(result.evidence.coverage.vector.map(row => row.decision)).toEqual(["in_scope_taxed", "in_scope_exempt", "in_scope_taxed"]);
    expect(result.money.taxTotal).toBe(12);
    expect(result.evidence.positions.tax.find(row => row.taxabilityReason === "product_exempt")).not.toHaveProperty("ratePercent");
  });

  it.each(["undeclared", "inactive", "ambiguous", "unknown registration", "unknown treatment", "unattributed null"] as const)(
    "holds the quote for %s coverage evidence", async scenario => {
      const f = setup();
      if (scenario === "undeclared") f.input.coverage = { ...f.input.coverage, declarations: [] };
      if (scenario === "inactive") f.client.registrations.list.mockResolvedValue(page(registrationUrl, []));
      if (scenario === "ambiguous") f.client.registrations.list.mockResolvedValue(page(registrationUrl, [registration(), registration("reg_second")]));
      if (scenario === "unknown registration") f.client.registrations.list.mockResolvedValue(page(registrationUrl, [registration("reg_unknown", "unknown")]));
      if (scenario === "unknown treatment" || scenario === "unattributed null") {
        f.client.calculations.create.mockImplementation(async params => snapshot(params, 0, {
          lineDetails: line => line.reference === "ol-m-1"
            ? [{ ...detail(0, 0), ...(scenario === "unattributed null" && { tax_rate_details: null }),
                taxability_reason: scenario === "unknown treatment" ? "unknown" : "product_exempt" }]
            : [detail(10, line.amount, "district-b")],
        }));
      }
      const outcome = scenario === "undeclared" ? { kind: "refused", code: "tax_coverage_undeclared" }
        : scenario === "inactive" ? { kind: "refused", code: "tax_coverage_inconsistent" }
        : { kind: "unavailable", code: "tax_coverage_evidence_unavailable", effect: "none" };
      expect(await f.run()).toMatchObject({ ...outcome, coverage: { vector: expect.any(Array), digest: expect.any(String) } });
    },
  );

  it("cannot establish inactivity from an unqualified or truncated inventory", async () => {
    const f = setup();
    f.input.coverage = { ...f.input.coverage, declarations: f.input.coverage.declarations.map(row =>
      ({ ...row, status: "not_registered_acknowledged", acknowledgementRef: "acknowledgement-a" })) };
    f.marketPack.registrations = f.marketPack.registrations.map(row => ({ ...row, complete: false }));
    f.client.registrations.list.mockResolvedValue(page(registrationUrl, []));
    f.client.calculations.create.mockImplementation(async params => snapshot(params, 0, {
      shippingDetails: [], lineDetails: () => [],
    }));
    expect(await f.run()).toMatchObject({ code: "tax_coverage_evidence_unavailable" });
    f.client.registrations.list.mockClear();
    f.client.calculations.create.mockClear();
    f.client.registrations.list.mockImplementation(async () =>
      page(registrationUrl, [registration("page_" + f.client.registrations.list.mock.calls.length)], true));
    expect(await f.run()).toMatchObject({ kind: "refused", code: "tax_breakdown_incomplete", field: "/registrations" });
    expect(f.client.registrations.list).toHaveBeenCalledTimes(10);
    expect(f.client.calculations.create).not.toHaveBeenCalled();
  });
});

describe("flat retail delivery fee", () => {
  it.each(["top_only", "shipping_mirror"] as const)("charges the free-delivery %s assessment once", async layout => {
    const f = setup();
    const fee = withFee(f, layout);
    f.client.registrations.list.mockResolvedValue(page(registrationUrl, [registration(), registration("reg_fee", "state_retail_delivery_fee")]));
    f.client.calculations.create.mockImplementation(async params => snapshot(params, 0, {
      fee, shippingDetails: [detail(0, 0), ...(layout === "shipping_mirror" ? [fee] : [])],
    }));
    const result = await f.run();
    expect(result.kind).toBe("final");
    expect(verifyTaxQuoteResult(f.request(), result)).toBeUndefined();
    if (result.kind !== "final") throw new Error("Expected a final quote.");
    expect(result.money).toMatchObject({ taxTotal: 20, fees: [{ feeKey: "fee-a", amountMinor: 7 }], feeTotal: 7, payableMinor: 227 });
    expect(result.evidence.positions.fees).toEqual([{
      feeKey: "fee-a", jurisdiction: "district-a", feeKind: "fee-kind", scope: { kind: "delivery", key: "shipping-a" },
      refundRule: { ref: "fee-refund-a", revision: "refund-revision-a" },
    }]);
    expect(result.evidence.coverage.vector.find(row => row.cell.target.kind === "fee")?.registration?.evidenceRef).toBe("reg_fee");
  });

  it.each([10, 6, 7])("reconciles a flat fee of 7 followed by %i across a discount", async amount => {
    const f = setup();
    const fee = withFee(f, "top_only");
    f.input.money.adjustments = [{ adjustmentRef: "discount-a", sequence: 4, amountMinor: 1, target: { lineKeys: ["item-z"] } }];
    f.client.registrations.list.mockResolvedValue(page(registrationUrl, [registration(), registration("reg_fee", "state_retail_delivery_fee")]));
    f.client.calculations.create.mockImplementation(async params => {
      const index = f.client.calculations.create.mock.calls.length - 1;
      return snapshot(params, index, { fee: index === 0 ? fee : { ...fee, amount } });
    });
    expect(await f.run()).toMatchObject(amount === 7 ? { kind: "final", money: { feeTotal: 7 } } : {
      kind: "refused", code: "tax_breakdown_incomplete", field: "/calculation/tax_breakdown/3/amount",
      remedy: expect.stringContaining("flat fee assessment changed between discount snapshots"),
    });
    expect(f.client.calculations.create).toHaveBeenCalledTimes(2);
  });

  it.each(["duplicate", "unbound", "no fee cell", "currency", "mismatched mirror", "missing mirror", "no fee registration"] as const)(
    "refuses %s fee evidence", async scenario => {
      const f = setup();
      const layout = scenario.endsWith("mirror") ? "shipping_mirror" : "top_only";
      const fee = withFee(f, layout);
      if (scenario === "unbound") f.marketPack.fees = [];
      if (scenario === "no fee cell") f.input.required = f.input.required.filter(cell => cell.target.kind !== "fee");
      if (scenario !== "no fee registration") {
        f.client.registrations.list.mockResolvedValue(page(registrationUrl, [registration(), registration("reg_fee", "state_retail_delivery_fee")]));
      }
      f.client.calculations.create.mockImplementation(async params => {
        const wire = snapshot(params, 0, { fee, shippingDetails: [detail(0, 0),
          ...(scenario === "mismatched mirror" ? [{ ...fee, amount: fee.amount - 1 }] : [])] });
        if (scenario === "duplicate") wire.tax_breakdown.push(wire.tax_breakdown.at(-1)!);
        if (scenario === "currency") wire.tax_breakdown.at(-1)!.tax_rate_details.flat_amount!.currency = "yyy";
        return wire;
      });
      const expectation = scenario === "unbound" || scenario === "no fee cell"
        ? { code: "tax_rule_missing", remedy: expect.stringContaining("Qualify the fee in the market pack") }
        : { code: scenario === "no fee registration" ? "tax_coverage_inconsistent" : "tax_breakdown_incomplete" };
      expect(await f.run()).toMatchObject({ kind: "refused", ...expectation });
    },
  );
});
