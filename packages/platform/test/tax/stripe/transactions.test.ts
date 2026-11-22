import { describe, expect, it } from "vitest";
import { compareTaxRecalculationProbe } from "../../../src/tax/index.js";
import type { TaxReverseRequestV1 } from "../../../src/tax/contracts/index.js";
import { date, later } from "../fixtures.js";
import { detail, snapshot, withFee, page, registration, registrationUrl } from "./fixtures.js";
import { lifecycleFixture } from "./lifecycleFixtures.js";

describe("reporting lifecycle", () => {
  it("posts the final calculation once and maps out-of-order lines and shipping before replaying after expiry", async () => {
    const f = lifecycleFixture();
    const port = f.open();
    const { commit, result } = await f.quoteAndReserve(port);
    const posted = await port.commit(commit);
    expect(posted).toEqual({ kind: "committed", providerTransactionRef: "tax_sale", positions: [
      { originalPositionRef: "item_0_0", postedPositionRef: "tax_line_0" },
      { originalPositionRef: "item_0_1", postedPositionRef: "tax_line_1" },
      { originalPositionRef: "shipping:calc_0", postedPositionRef: "shipping:tax_sale" },
    ] });
    const [[wire, write]] = f.client.transactions.createFromCalculation.mock.calls;
    expect(wire).toMatchObject({ calculation: result.evidence.calculationRef, posted_at: Date.parse(date) / 1000,
      reference: expect.stringMatching(/^ol-tax-[a-f0-9]{64}$/), metadata: { openlup_request_digest: expect.stringMatching(/^[a-f0-9]{64}$/) } });
    expect(write.idempotencyKey).toEqual("ol-tax-commit-" + wire.reference.slice(7));
    f.setTime(later);
    expect(await port.commit(commit)).toEqual(posted);
    expect(await port.commit({ ...commit, intent: "recover" })).toEqual(posted);
    expect(f.effects().commits).toBe(1);
  });

  it.each(["closed", "expired", "capture", "deadline", "fee", "conflict"] as const)("refuses %s before reporting", async scenario => {
    const f = lifecycleFixture();
    if (scenario === "fee") {
      const fee = withFee(f, "top_only");
      f.client.registrations.list.mockResolvedValue(page(registrationUrl, [registration(), registration("reg_fee", "state_retail_delivery_fee")]));
      f.setResult(params => snapshot(params, 0, { fee, shippingDetails: [detail(0, 0)] }));
    }
    const port = f.open();
    const { commit, reservation } = await f.quoteAndReserve(port);
    if (scenario === "closed") {
      expect(await port.closeCalculation(commit.calculationRef, { kind: "verified_unpaid", evidenceRef: "receipt" }, "close-a"))
        .toMatchObject({ kind: "closed" });
      f.localClose();
    }
    if (scenario === "expired") f.setTime(later);
    if (scenario === "capture") reservation.capture.payableMinor++;
    if (scenario === "deadline") reservation.send = { kind: "ready", before: date };
    const input = scenario === "conflict" ? { ...commit, captureEvidenceRef: "other" } : commit;
    const code = { closed: "tax_calculation_closed", expired: "tax_calculation_expired", capture: "tax_reference_conflict",
      deadline: "tax_operation_unsupported", fee: "tax_operation_unsupported", conflict: "tax_reference_conflict" }[scenario];
    expect(await port.commit(input)).toMatchObject({ kind: "refused", code });
    expect(f.effects().commits).toBe(0);
  });

  it("preserves an ambiguous reservation through a lookup miss and verifies a positive readback", async () => {
    const f = lifecycleFixture();
    const port = f.open();
    const { commit, reservation } = await f.quoteAndReserve(port);
    f.loseResponse();
    expect(await port.commit(commit)).toEqual({ kind: "unavailable", code: "tax_adapter_unavailable", effect: "unknown" });
    reservation.send = { kind: "unknown" };
    expect(await port.commit({ ...commit, intent: "recover" })).toMatchObject({ kind: "unavailable", effect: "unknown" });
    expect(await port.commit(commit)).toMatchObject({ kind: "unavailable", effect: "unknown" });
    const [{ reference }] = f.client.transactions.createFromCalculation.mock.calls[0];
    f.references.set(reference, "tax_wrong");
    expect(await port.commit({ ...commit, intent: "recover" })).toMatchObject({ kind: "unavailable", effect: "unknown" });
    f.references.set(reference, "tax_sale");
    expect(await port.commit({ ...commit, intent: "recover" })).toMatchObject({ kind: "committed", providerTransactionRef: "tax_sale" });
    expect(f.effects().commits).toBe(1);
  });

  it("checks reversal line deltas, receipt scope and unsupported modes", async () => {
    const f = lifecycleFixture({ single: true });
    const port = f.open();
    const { commit } = await f.quoteAndReserve(port);
    expect(await port.commit(commit)).toMatchObject({ kind: "committed" });
    const input: TaxReverseRequestV1 = { intent: "apply", mode: "lines", scope: f.input.scope, originalRef: "tax_sale",
      reversalRef: "refund-a", refundEvidenceRef: "refund", currency: f.input.currency, fromMinor: 0, toMinor: 40,
      positions: [{ originalPositionRef: "item_0_0", netDeltaMinor: -40, taxDeltaMinor: 0, feeDeltaMinor: 0 }] };
    expect(await port.reverse({ ...input, mode: "amount", amountMinor: 40 })).toMatchObject({ code: "tax_operation_unsupported" });
    const fee = { ...input, feeEvidenceRef: "fee-evidence", positions: [{ ...input.positions[0], netDeltaMinor: -39, feeDeltaMinor: -1 }] };
    const units = [{ kind: "line" as const, originalPositionRef: "item_0_0", postedPositionRef: "tax_line_0", taxCode: "txcd_101",
      remainingNetMinor: 100, remainingTaxMinor: 0 }];
    f.reserveReverse(fee, units, 100);
    expect(await port.reverse(fee)).toMatchObject({ code: "tax_reversal_unsubstantiated" });
    expect(f.effects().reversals).toBe(0);
    f.reserveReverse(input, units, 100);
    const reversal = await port.reverse(input);
    expect(reversal).toEqual({ kind: "reversed", providerReversalRef: "tax_refund_1", positions: input.positions });
    expect(f.client.transactions.createReversal.mock.calls[0][0]).toMatchObject({
      mode: "partial", line_items: [{ original_line_item: "tax_line_0", reference: "ol-r-0", amount: -40, amount_tax: 0 }],
    });
    f.receipts.get("tax_refund_1")!.line_items.data[0].livemode = true;
    expect(await port.reverse({ ...input, intent: "recover" })).toMatchObject({ kind: "unavailable", effect: "unknown" });
    expect(f.effects().reversals).toBe(1);
  });

  it("maps a deterministic quote rejection with its field and remedy", async () => {
    const f = lifecycleFixture();
    f.client.calculations.create.mockRejectedValueOnce(Object.assign(new Error("Supply a valid tax address."), {
      name: "TaxProviderRejection", code: "tax_invalid_input", field: "/input/destination/address",
    }));
    expect(await f.open().quote(f.request())).toEqual({ kind: "refused", code: "tax_invalid_input",
      field: "/input/destination/address", remedy: "Supply a valid tax address." });
  });
});

describe("retry validity probe", () => {
  it.each([["10", "equal"], ["9", "different"]] as const)("compares rate %s at the retry instant", async (rate, kind) => {
    const f = lifecycleFixture({ single: true });
    const port = f.open();
    const boundRequest = f.request();
    const retryAt = "2030-01-02T00:00:00.000Z";
    f.setResult(params => snapshot(params, 0, { lineDetails: row => [detail(10, row.amount)] }));
    const bound = await port.quote(boundRequest);
    expect(bound.kind).toBe("final");
    if (bound.kind !== "final") throw new Error("Expected final quote");
    f.setTime(retryAt);
    const request = f.probeRequest(retryAt);
    expect(port.capabilities().validity).toBe("probe_by_recalculation");
    expect(await port.readFiscalValidity({ original: boundRequest, evidence: bound.evidence, evidenceDigest: bound.evidenceDigest,
      chargeAt: retryAt, current: request.input })).toEqual({ kind: "unavailable", code: "tax_fiscal_validity_unavailable", effect: "none" });
    expect(f.client.calculations.create).toHaveBeenCalledTimes(1);
    f.setResult(params => snapshot(params, 1, { lineDetails: row =>
      [{ ...detail(Number(rate), row.amount), tax_rate_details: { tax_type: "sales_tax", percentage_decimal: rate } }] }));
    const result = await port.quote(request);
    const keys = f.client.calculations.create.mock.calls.map(([, opts]) => opts.idempotencyKey);
    expect(new Set(keys).size).toBe(2);
    expect(compareTaxRecalculationProbe(boundRequest, bound, request, result))
      .toEqual(kind === "equal" ? { kind } : { kind, field: "positions" });
    expect(compareTaxRecalculationProbe(boundRequest, bound, { ...request, key: "different-key" }, result))
      .toMatchObject({ kind: "refused", code: "tax_reference_conflict" });
    expect(compareTaxRecalculationProbe(boundRequest, bound, boundRequest, bound)).toMatchObject({ kind: "refused" });
  });
});
