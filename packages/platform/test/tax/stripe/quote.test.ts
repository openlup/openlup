import { describe, expect, it } from "vitest";
import type { TaxQuoteRequestV1, TaxQuoteResultV1 } from "../../../src/tax/contracts/index.js";
import { makeTaxQuoteRequest, taxDigest, verifyTaxQuoteResult } from "../../../src/tax/digest.js";
import { StripeQuoteReferenceConflict } from "../../../src/tax/stripe/client.js";
import { quoteStripeTax } from "../../../src/tax/stripe/quote.js";
import { date, later } from "../fixtures.js";
import { detail, fakeClient, fixture, lineUrl, now, page, seconds, snapshot } from "./fixtures.js";

function assertSuccess(request: TaxQuoteRequestV1, result: TaxQuoteResultV1) {
  expect(result.kind, JSON.stringify(result)).toBe(request.input.purpose);
  expect(verifyTaxQuoteResult(request, result)).toBeUndefined();
  if (result.kind !== "final" && result.kind !== "estimate") throw new Error("Expected a successful quote.");
  return result;
}

function setup(f = fixture()) {
  const client = fakeClient(f.input.scope);
  return { ...f, client, run: (request = f.request()) => quoteStripeTax({ client, marketPack: f.marketPack, now }, request) };
}

describe("private tax calculation quote", () => {
  it("binds one calculation to the original request, exact wire projection and verified money", async () => {
    const { request, client, run } = setup();
    const original = request();
    const result = assertSuccess(original, await run(original));
    expect(result.money).toMatchObject({ netTotal: 220, taxTotal: 22, feeTotal: 0, payableMinor: 242 });
    expect(result.evidence).toMatchObject({
      requestKey: original.key, inputDigest: original.inputDigest, calculationRef: "calc_0", calculatedAt: date, expiresAt: later,
      policyRevision: original.input.policyRevision, classMapRevision: original.input.classMapRevision,
    });
    expect(result.evidence.positions.tax.filter(row => row.cell.target.kind === "line").map(row => row.providerLineRef).sort())
      .toEqual(["item_0_0", "item_0_1"]);
    expect(verifyTaxQuoteResult({ ...original, key: "other-evaluation" }, result)).toMatchObject({
      code: "tax_reference_conflict", field: "/evidence/requestKey",
    });
    expect(client.calculations.create).toHaveBeenCalledExactlyOnceWith({
      currency: "xxx", tax_date: seconds(date), expand: ["shipping_cost.tax_breakdown"],
      line_items: [
        { amount: 100, quantity: 2, reference: "ol-m-1", tax_code: "txcd_101", tax_behavior: "exclusive",
          metadata: { input_digest: original.inputDigest, sequence: "0" } },
        { amount: 100, quantity: 1, reference: "ol-m-2", tax_code: "txcd_101", tax_behavior: "exclusive",
          metadata: { input_digest: original.inputDigest, sequence: "0" } },
      ],
      shipping_cost: { amount: 20, tax_code: "txcd_102", tax_behavior: "exclusive" },
      customer_details: { address: { line1: "1 Example Lane", city: "Example", postal_code: "0000", country: "XX", state: "RA" },
        address_source: "shipping" },
      ship_from_details: { address: { line1: "Synthetic origin", line2: "Suite sample", city: "Example",
        postal_code: "0000", country: "XX", state: "RA" } },
    }, { idempotencyKey: expect.stringMatching(/^tax-quote-[0-9a-f]{64}$/) });
    expect(client.registrations.list).toHaveBeenCalledExactlyOnceWith({ status: "all", limit: 100 });
    expect(client.calculations.listLineItems).not.toHaveBeenCalled();
  });

  it("uses one snapshot per distinct nonzero sequence and preserves component-local states", async () => {
    const { input, request, client, run } = setup();
    input.money.adjustments = [
      { adjustmentRef: "a", sequence: 3, amountMinor: 3, target: { lineKeys: ["item-z", "item-a"] } },
      { adjustmentRef: "b", sequence: 5, amountMinor: 0, target: { bucketKey: "shipping-a" } },
      { adjustmentRef: "c", sequence: 7, amountMinor: 1, target: { lineKeys: ["item-a"] } },
    ];
    const original = request();
    const result = assertSuccess(original, await run(original));
    expect(client.calculations.create.mock.calls.map(([body]) => body.line_items.map(line => [line.amount, line.metadata.sequence])))
      .toEqual([[[100, "0"], [100, "0"]], [[98, "3"], [99, "3"]], [[98, "7"], [98, "7"]]]);
    const keys = client.calculations.create.mock.calls.map(([, options]) => options.idempotencyKey);
    expect(new Set(keys).size).toBe(3);
    expect(result.money.components.map(row => row.allocations.map(state => state.sequence))).toEqual([[3], [3, 7], []]);
    expect(result.money.payableMinor).toBe(236);
    expect(result.evidence.calculationRef).toBe("calc_2");
    expect(result.evidence.positions.tax.filter(row => row.cell.target.kind === "line").map(row => row.providerLineRef).sort())
      .toEqual(["item_2_0", "item_2_1"]);
    await run(original);
    expect(client.calculations.create.mock.calls.slice(3).map(([, options]) => options.idempotencyKey)).toEqual(keys);
  });

  it("retains zero assessments, uses the final line ID and makes coverage stable under wire ordering", async () => {
    const f = setup();
    const original = f.request();
    f.client.calculations.create.mockImplementation(async params => {
      const result = snapshot(params, 0, { lineDetails: line => line.reference === "ol-m-1"
        ? [detail(0, line.amount), { ...detail(1, line.amount), tax_rate_details: { tax_type: "sales_tax", percentage_decimal: "1" } }]
        : [detail(0, line.amount, "district-b")] });
      result.line_items.data[0].tax_breakdown.reverse();
      result.line_items.data.reverse();
      result.tax_breakdown.reverse();
      return result;
    });
    const result = assertSuccess(original, await f.run(original));
    expect(result.money.components[0].final.taxPositions.map(row => row.taxMinor).sort()).toEqual([0, 1]);
    expect(result.money.components[1].final.taxPositions).toEqual([expect.objectContaining({ taxMinor: 0 })]);
    expect(result.evidence.coverage.vector.every(row => row.decision === "in_scope_taxed")).toBe(true);
    expect(result.evidence.positions.tax).toHaveLength(4);
  });

  it.each(["matching", "different state and basis", "missing header", "extra header"] as const)(
    "checks a %s header for tax that rounds to zero", async shape => {
      const f = setup();
      f.client.calculations.create.mockImplementation(async params => {
        const wire = snapshot(params, 0, { lineDetails: line => line.reference === "ol-m-1"
          ? [{ ...detail(0, line.amount), tax_rate_details: { tax_type: "sales_tax", percentage_decimal: "0.010000" } }]
          : [detail(10, line.amount, "district-b")] });
        const zero = wire.tax_breakdown[0];
        if (shape === "different state and basis") {
          zero.taxable_amount = 1;
          zero.tax_rate_details.state = "RB";
        }
        if (shape === "missing header") wire.tax_breakdown.shift();
        if (shape === "extra header") wire.tax_breakdown.push({
          ...zero, taxable_amount: 0, tax_rate_details: { ...zero.tax_rate_details, state: "RB" },
        });
        return wire;
      });
      const request = f.request();
      const result = await f.run(request);
      if (shape === "matching") {
        const verified = assertSuccess(request, result);
        expect(verified.money.components[0].final.taxPositions).toEqual([
          expect.objectContaining({ taxMinor: 0, taxableMinor: 100, rateDecimal: "0.01" }),
        ]);
        expect(verified.evidence.positions.tax).toContainEqual(expect.objectContaining({ ratePercent: "0.01" }));
      } else {
        const field = {
          "different state and basis": "/calculation/tax_breakdown/0/tax_rate_details",
          "missing header": "/calculation/tax_breakdown",
          "extra header": "/calculation/tax_breakdown/3/tax_rate_details",
        }[shape];
        expect(result).toMatchObject({ kind: "refused", code: "tax_breakdown_incomplete", field });
      }
    },
  );

  it("keeps the same shipping position when its rate spelling changes after a one-unit merchandise discount", async () => {
    const f = setup();
    f.input.money.adjustments = [{ adjustmentRef: "discount-a", sequence: 1, amountMinor: 1, target: { lineKeys: ["item-z"] } }];
    f.client.calculations.create.mockImplementation(async params => {
      const index = f.client.calculations.create.mock.calls.length - 1;
      const wire = snapshot(params, index);
      if (index === 1) {
        wire.shipping_cost!.tax_breakdown[0].tax_rate_details!.percentage_decimal = "10";
        wire.tax_breakdown.at(-1)!.tax_rate_details.percentage_decimal = "10";
      }
      return wire;
    });
    const request = f.request();
    const verified = assertSuccess(request, await f.run(request));
    expect(f.client.calculations.create).toHaveBeenCalledTimes(2);
    const shipping = verified.money.components.find(component => component.ref.kind === "delivery")!;
    expect(shipping.allocations).toEqual([]);
    expect(shipping.final.taxPositions).toEqual([expect.objectContaining({ rateDecimal: "10", taxableMinor: 20, taxMinor: 2 })]);
    expect(verified.evidence.positions.tax.filter(row => row.cell.target.kind === "delivery")).toEqual([
      expect.objectContaining({ positionRef: shipping.final.taxPositions[0].positionRef, ratePercent: "10" }),
    ]);
  });

  it("supports origin sourcing and carries a future estimate as an estimate", async () => {
    const f = setup(fixture("estimate"));
    f.input.taxDate = new Date(Date.parse(date) + 86400000).toISOString();
    f.input.required = f.input.required.map(cell => ({ ...cell, sourcing: "ship_from" }));
    f.marketPack.jurisdictions = f.marketPack.jurisdictions.map(row => ({ ...row, sourcing: "ship_from" }));
    f.client.calculations.create.mockImplementation(async params => {
      const wire = snapshot(params);
      for (const row of [...wire.line_items.data.flatMap(line => line.tax_breakdown), ...wire.shipping_cost!.tax_breakdown]) row.sourcing = "origin";
      return wire;
    });
    const result = assertSuccess(f.request(), await f.run());
    expect(result.evidence.taxDate).toBe(f.input.taxDate);
    expect(result.evidence.positions.tax.every(row => row.cell.sourcing === "ship_from")).toBe(true);
  });

  it("reads expanded and paged detail to completion using the last ID as cursor", async () => {
    const f = setup();
    f.client.calculations.create.mockImplementation(async params => {
      const wire = snapshot(params);
      const second = wire.line_items.data.pop()!;
      wire.line_items.has_more = true;
      f.client.calculations.listLineItems.mockResolvedValueOnce(page(lineUrl(wire.id), [second]));
      return wire;
    });
    assertSuccess(f.request(), await f.run());
    expect(f.client.calculations.listLineItems).toHaveBeenCalledExactlyOnceWith("calc_0", {
      limit: 100, starting_after: "item_0_0", expand: ["data.tax_breakdown"],
    });
    f.client.calculations.create.mockImplementation(async params => {
      const { line_items, ...wire } = snapshot(params);
      f.client.calculations.listLineItems.mockResolvedValueOnce(line_items);
      return wire;
    });
    assertSuccess(f.request(), await f.run());
    expect(f.client.calculations.listLineItems).toHaveBeenLastCalledWith("calc_0", { limit: 100, expand: ["data.tax_breakdown"] });
  });

  it.each([
    ["foreign calculation mode", (wire: ReturnType<typeof snapshot>) => { wire.livemode = true; }, "tax_scope_mismatch", "/calculation/livemode"],
    ["foreign calculation account", (wire: ReturnType<typeof snapshot>) => { Object.assign(wire, { account: "other-account" }); }, "tax_scope_mismatch", "/calculation/account"],
    ["foreign line mode", (wire: ReturnType<typeof snapshot>) => { wire.line_items.data[0].livemode = true; }, "tax_scope_mismatch", "/line_items/0/data/0/livemode"],
    ["wrong parent", (wire: ReturnType<typeof snapshot>) => { wire.line_items.data[0].calculation = "calc_foreign"; }, "tax_breakdown_incomplete", "/line_items/0/data/0/calculation"],
    ["missing breakdown", (wire: ReturnType<typeof snapshot>) => { Reflect.deleteProperty(wire.line_items.data[0], "tax_breakdown"); }, "tax_breakdown_incomplete", "/line_items/0/data/0/tax_breakdown"],
    ["unsafe money", (wire: ReturnType<typeof snapshot>) => { wire.amount_total = Number.MAX_SAFE_INTEGER + 1; }, "tax_amount_out_of_range", "/calculation/amount_total"],
    ["bad total", (wire: ReturnType<typeof snapshot>) => { wire.amount_total++; }, "tax_breakdown_incomplete", "/calculation/amount_total"],
    ["bad header group", (wire: ReturnType<typeof snapshot>) => { wire.tax_breakdown[0].tax_rate_details.state = "RB"; }, "tax_breakdown_incomplete", "/calculation/tax_breakdown/0/tax_rate_details"],
    ["wrong tax date", (wire: ReturnType<typeof snapshot>) => { wire.tax_date++; }, "tax_breakdown_incomplete", "/calculation/tax_date"],
    ["wrong address", (wire: ReturnType<typeof snapshot>) => { wire.customer_details.address.city = "Other"; }, "tax_breakdown_incomplete", "/calculation/customer_details/address/city"],
    ["wrong digest echo", (wire: ReturnType<typeof snapshot>) => { wire.line_items.data[0].metadata.input_digest = "other"; }, "tax_breakdown_incomplete", "/line_items/0/data/0/metadata/input_digest"],
    ["expiry at observation", (wire: ReturnType<typeof snapshot>) => { wire.expires_at = seconds(date); }, "tax_calculation_expired", "/calculation/expires_at"],
  ] as const)("refuses %s", async (_case, mutate, code, field) => {
    const f = setup();
    f.client.calculations.create.mockImplementation(async params => {
      const wire = snapshot(params);
      mutate(wire);
      return wire;
    });
    expect(await f.run()).toMatchObject({ kind: "refused", code, field, remedy: expect.any(String) });
  });

  it.each([
    ["malformed line breakdown", (wire: ReturnType<typeof snapshot>) => {
      Object.assign(wire.line_items.data[0], { tax_breakdown: {} });
    }, "/line_items/0/data/0/tax_breakdown"],
    ["missing calculation marker", (wire: ReturnType<typeof snapshot>) => {
      Reflect.deleteProperty(wire, "object");
    }, "/calculation/object"],
    ["non-number amount", (wire: ReturnType<typeof snapshot>) => {
      Object.assign(wire, { amount_total: "242" });
    }, "/calculation/amount_total"],
    ["wrong mode-echo type", (wire: ReturnType<typeof snapshot>) => {
      Object.assign(wire, { livemode: "false" });
    }, "/calculation/livemode"],
    ["taxable basis reduced from 100 to 0", (wire: ReturnType<typeof snapshot>) => {
      wire.tax_breakdown[0].taxable_amount = 0;
    }, "/calculation/tax_breakdown/0/taxable_amount"],
  ] as const)("refuses %s as provider evidence at its field", async (_case, mutate, field) => {
    const f = setup();
    f.client.calculations.create.mockImplementation(async params => {
      const wire = snapshot(params);
      mutate(wire);
      return wire;
    });
    expect(await f.run()).toMatchObject({
      kind: "refused", code: "tax_breakdown_incomplete", field,
      remedy: expect.stringContaining("Obtain the complete expanded evidence for the original calculation and reconcile the named field"),
    });
  });

  it.each(["unmapped special district", "duplicate binding"] as const)("identifies the market-pack gap for a %s", async scenario => {
    const f = setup();
    if (scenario === "duplicate binding") f.marketPack.jurisdictions = [...f.marketPack.jurisdictions, f.marketPack.jurisdictions[0]];
    f.client.calculations.create.mockImplementation(async params => snapshot(params, 0, {
      lineDetails: line => line.reference === "ol-m-1"
        ? [detail(10, line.amount), ...(scenario === "unmapped special district" ? [detail(1, line.amount, "district-special")] : [])]
        : [detail(10, line.amount, "district-b")],
    }));
    expect(await f.run()).toMatchObject({
      kind: "refused", code: "tax_rule_missing",
      field: "/line_items/0/data/0/tax_breakdown/" + (scenario === "unmapped special district" ? 1 : 0) + "/jurisdiction",
      remedy: expect.stringContaining("market pack"),
    });
  });

  it.each(["duplicate", "empty", "foreign page", "outage"] as const)("fails a %s line continuation", async failure => {
    const f = setup();
    f.client.calculations.create.mockImplementation(async params => {
      const wire = snapshot(params);
      wire.line_items.data.pop();
      wire.line_items.has_more = true;
      if (failure !== "outage") {
        f.client.calculations.listLineItems.mockResolvedValueOnce(page(failure === "foreign page" ? lineUrl("calc_other") : lineUrl(wire.id),
          failure === "duplicate" ? wire.line_items.data : []));
      }
      return wire;
    });
    expect(await f.run()).toMatchObject(failure === "outage"
      ? { kind: "unavailable", code: "tax_adapter_unavailable", effect: "none" }
      : { kind: "refused", code: "tax_breakdown_incomplete" });
  });

  it("refuses a changed treatment, changed unallocated tax or increasing discounted tax", async () => {
    const f = setup();
    f.input.money.adjustments = [{ adjustmentRef: "a", sequence: 4, amountMinor: 10, target: { lineKeys: ["item-z"] } }];
    const changes = [
      { code: "Coverage treatment changed", options: { lineDetails: (line: { reference: string; amount: number }) =>
        line.reference === "ol-m-1" ? [{ ...detail(9, line.amount), taxability_reason: "reduced_rated" }] : [detail(10, 100, "district-b")] } },
      { code: "unallocated component changed", options: { shippingDetails: [detail(1, 20)] } },
      { code: "tax increased", options: { lineDetails: (line: { reference: string; amount: number }) =>
        line.reference === "ol-m-1" ? [detail(11, line.amount)] : [detail(10, 100, "district-b")] } },
    ];
    for (const { code, options } of changes) {
      f.client.calculations.create.mockImplementationOnce(async params => snapshot(params))
        .mockImplementationOnce(async params => snapshot(params, 1, options));
      expect(await f.run()).toMatchObject({ kind: "refused",
        code: code === "tax increased" ? "tax_breakdown_incomplete" : "tax_operation_unsupported", remedy: expect.stringContaining(code) });
    }
  });

  it("refuses invalid request bindings before planning and reserves scope-specific idempotency keys", async () => {
    const f = setup();
    const original = f.request();
    expect(await f.run({ ...original, inputDigest: "b".repeat(64) })).toMatchObject({ code: "tax_reference_conflict" });
    const inclusive = { ...original.input, money: { ...original.input.money, amountBasis: "inclusive" } };
    const changed = { ...original, input: inclusive } as unknown as TaxQuoteRequestV1;
    expect(await f.run(changed)).toMatchObject({ code: "tax_reference_conflict", field: "/inputDigest" });
    expect(await f.run({ ...changed, inputDigest: taxDigest("input", inclusive) }))
      .toMatchObject({ code: "tax_scope_mismatch", field: "/input/money/amountBasis" });
    expect(await f.run(makeTaxQuoteRequest(original.key, { ...original.input, scope: { ...original.input.scope, accountRef: "another" },
      coverage: { ...original.input.coverage, accountRef: "another" } }))).toMatchObject({ code: "tax_scope_mismatch" });
    expect(f.client.registrations.list).not.toHaveBeenCalled();
    expect(f.client.calculations.create).not.toHaveBeenCalled();

    f.client.calculations.create.mockRejectedValueOnce(new StripeQuoteReferenceConflict());
    expect(await f.run()).toMatchObject({ code: "tax_reference_conflict", field: "/key", remedy: expect.stringContaining("Replay the original") });
    f.client.calculations.create.mockRejectedValueOnce(new Error("transport outage"));
    expect(await f.run()).toMatchObject({ kind: "unavailable", code: "tax_adapter_unavailable", effect: "none" });
  });

  it.each([
    [{ accountRef: "other-account", mode: "test" }, "/input/scope/accountRef"],
    [{ accountRef: "account-a", mode: "live" }, "/input/scope/mode"],
  ] as const)("refuses a mismatched client scope before transport (%j)", async (scope, field) => {
    const f = fixture();
    const client = fakeClient(scope);
    expect(await quoteStripeTax({ client, marketPack: f.marketPack, now }, f.request())).toMatchObject({
      kind: "refused", code: "tax_scope_mismatch", field,
    });
    expect(client.registrations.list).not.toHaveBeenCalled();
    expect(client.calculations.create).not.toHaveBeenCalled();
    expect(client.calculations.listLineItems).not.toHaveBeenCalled();
  });

  it("pins the request during provider I/O and refuses a changed caller binding", async () => {
    const f = setup();
    const original = { ...f.request() };
    f.client.calculations.create.mockImplementation(async params => {
      original.key = "changed-evaluation";
      return snapshot(params);
    });
    expect(await f.run(original)).toMatchObject({ code: "tax_reference_conflict", field: "/evidence/requestKey" });
  });

  it.each(["zero", "zero after discount", "handling", "ten discounts", "class", "origin", "partial second", "delivery facts"] as const)(
    "preflights an unsupported %s plan without I/O", async shape => {
      const f = setup();
      if (shape === "zero") f.input.money.sources[0] = { ...f.input.money.sources[0], unitBasisMinor: 0 };
      if (shape === "zero after discount" || shape === "ten discounts") {
        f.input.money.adjustments = Array.from({ length: shape === "ten discounts" ? 10 : 1 }, (_, index) =>
          ({ adjustmentRef: "discount-" + index, sequence: index + 1, target: { lineKeys: ["item-z"] }, amountMinor: shape === "ten discounts" ? 1 : 100 }));
      }
      if (shape === "handling") f.input.money.delivery[0] = { ...f.input.money.delivery[0], deliveryKind: "handling" };
      if (shape === "class") f.marketPack.taxCodes = {};
      if (shape === "origin") f.marketPack.origins = {};
      if (shape === "partial second") f.input.taxDate = date.replace(".000", ".001");
      if (shape === "delivery facts") f.marketPack.delivery = f.marketPack.delivery.map(rule => ({ ...rule, costIndependent: false }));
      const code = { class: "tax_class_missing", origin: "tax_rule_missing" } as const;
      expect(await f.run()).toMatchObject({ kind: "refused", code: shape in code ? code[shape as keyof typeof code] : "tax_operation_unsupported" });
      expect(f.client.registrations.list).not.toHaveBeenCalled();
      expect(f.client.calculations.create).not.toHaveBeenCalled();
    },
  );
});
