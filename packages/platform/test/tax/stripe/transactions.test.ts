import { describe, expect, it } from "vitest";
import { compareTaxRecalculationProbe, makeTaxQuoteRequest, verifyTaxQuoteRequest, verifyTaxQuoteResult } from "../../../src/tax/index.js";
import { makeStripeTaxRequestDigest } from "../../../src/tax/stripe/index.js";
import type { TaxRefusal, TaxReverseRequestV1 } from "../../../src/tax/contracts/index.js";
import { date, later } from "../fixtures.js";
import { detail, snapshot, withFee, page, registration, registrationUrl } from "./fixtures.js";
import { lifecycleFixture } from "./lifecycleFixtures.js";

function expectIntegrityRefusal(result: unknown, code: "tax_reference_conflict" | "tax_scope_mismatch" = "tax_reference_conflict") {
  expect(result).toMatchObject({ kind: "refused", code });
  expect(Reflect.ownKeys(result as object).map(String).sort()).toEqual(["code", "field", "kind", "remedy"]);
  const { remedy } = result as TaxRefusal;
  expect(remedy).not.toMatch(/[a-f0-9]{64}/iu);
  expect(remedy).not.toMatch(/\d/u);
}

async function postedLine() {
  const f = lifecycleFixture({ single: true });
  const port = f.open();
  const { commit } = await f.quoteAndReserve(port);
  expect(await port.commit(commit)).toMatchObject({ kind: "committed" });
  const input: TaxReverseRequestV1 = { intent: "apply", mode: "lines", scope: f.input.scope, originalRef: "tax_sale",
    reversalRef: "refund-a", refundEvidenceRef: "refund", currency: f.input.currency, fromMinor: 0, toMinor: 40,
    positions: [{ originalPositionRef: "item_0_0", netDeltaMinor: -40, taxDeltaMinor: 0, feeDeltaMinor: 0 }] };
  const units = [{ kind: "line" as const, originalPositionRef: "item_0_0", postedPositionRef: "tax_line_0", taxCode: "txcd_101",
    remainingNetMinor: 100, remainingTaxMinor: 0 }];
  return { f, port, commit, input, units };
}

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
      reference: expect.stringMatching(/^ol-tax-commit-[a-f0-9]{64}$/), metadata: { openlup_request_digest: expect.stringMatching(/^[a-f0-9]{64}$/) } });
    expect(write.idempotencyKey).toEqual(wire.reference);
    f.setTime(later);
    expect(await port.commit(commit)).toEqual(posted);
    expect(await port.commit({ ...commit, intent: "recover" })).toEqual(posted);
    expect(f.effects().commits).toBe(1);
  });

  it.each(["commit-first", "reverse-first"])("reports both operations with local reference forty-two in %s order", async order => {
    const { f, port, input, units } = await postedLine();
    const { commit } = await f.quoteAndReserve(port, "42");
    const refund = { ...input, reversalRef: "42" };
    f.reserveReverse(refund, units, 100);
    const sale = () => port.commit(commit);
    const reverse = () => port.reverse(refund);
    if (order === "commit-first") {
      expect(await sale()).toMatchObject({ kind: "committed" });
      expect(await reverse()).toMatchObject({ kind: "reversed" });
    } else {
      expect(await reverse()).toMatchObject({ kind: "reversed" });
      expect(await sale()).toMatchObject({ kind: "committed" });
    }
    const [[originalWire], [saleWire]] = f.client.transactions.createFromCalculation.mock.calls;
    const [[refundWire, refundWrite]] = f.client.transactions.createReversal.mock.calls;
    expect(saleWire.reference).not.toBe(originalWire.reference);
    expect(refundWire.reference).toMatch(/^ol-tax-reverse-[a-f0-9]{64}$/u);
    expect(refundWire.reference).not.toBe(saleWire.reference);
    expect(refundWrite.idempotencyKey).toBe(refundWire.reference);
    expect(f.lookup).toHaveBeenCalledWith(saleWire.reference);
    expect(f.lookup).toHaveBeenCalledWith(refundWire.reference);
    expect(await port.commit({ ...commit, intent: "recover" })).toMatchObject({ kind: "committed" });
    expect(await port.reverse({ ...refund, intent: "recover" })).toMatchObject({ kind: "reversed" });
    expect(f.effects()).toEqual({ commits: 2, reversals: 1, providerCloses: 0 });
  });

  it("posts verified merchandise line IDs even when a line has no tax rows", async () => {
    const f = lifecycleFixture();
    f.input.money.delivery = [];
    f.input.delivery = [];
    f.input.required = f.input.required.filter(cell => cell.target.kind === "line");
    f.input.coverage = { ...f.input.coverage, declarations: f.input.coverage.declarations.map(row => row.jurisdiction === "district-b"
      ? { ...row, status: "not_registered_acknowledged", acknowledgementRef: "ack-b" } : row) };
    f.marketPack.registrations = f.marketPack.registrations.map(row => row.jurisdiction === "district-b" ? { ...row, state: "RB" } : row);
    f.setResult(params => snapshot(params, 0, { lineDetails: row => row.reference === "ol-m-2" ? [] : [detail(10, row.amount)] }));
    const port = f.open();
    const { commit, result } = await f.quoteAndReserve(port);
    expect(verifyTaxQuoteResult(f.request(), result)).toBeUndefined();
    expect(result.evidence.coverage.vector.map(row => row.decision).sort()).toEqual(["in_scope_taxed", "out_of_scope"]);
    expect(result.evidence.positions.tax).toHaveLength(1);
    expect(result.evidence.providerLines).toEqual(f.input.money.sources.map(({ lineKey }, index) =>
      ({ lineKey, providerLineRef: "item_0_" + index })));
    expect(await port.commit(commit)).toEqual({ kind: "committed", providerTransactionRef: "tax_sale", positions: [
      { originalPositionRef: "item_0_0", postedPositionRef: "tax_line_0" },
      { originalPositionRef: "item_0_1", postedPositionRef: "tax_line_1" },
    ] });
  });

  it("refuses calculation lines whose provider ID is missing", async () => {
    const f = lifecycleFixture();
    f.setResult(params => {
      const response = snapshot(params);
      Reflect.deleteProperty(response.line_items.data[1], "id");
      return response;
    });
    expect(await f.open().quote(f.request())).toMatchObject({ kind: "refused", code: "tax_breakdown_incomplete" });
    expect(f.effects().commits).toBe(0);
  });

  it("posts with the request digest as the only persisted hash", async () => {
    const f = lifecycleFixture();
    const port = f.open();
    const { commit, reservation } = await f.quoteAndReserve(port);
    expect(Object.keys(reservation).sort()).toEqual(["capture", "requestDigest", "send"]);
    expect(reservation.requestDigest).toBe(makeStripeTaxRequestDigest({
      operation: "commit", request: { ...commit, intent: "recover" }, capture: reservation.capture,
    }));
    expect(await port.commit(commit)).toMatchObject({ kind: "committed" });
  });

  it("points captures before calculation to the original payment and calculation", async () => {
    const f = lifecycleFixture();
    const port = f.open();
    const { commit, result } = await f.quoteAndReserve(port);
    const input = { ...commit, capturedAt: "2029-12-31T23:59:59.000Z" };
    f.reserveCommit(input, result.money.payableMinor);
    expect(await port.commit(input)).toEqual({ kind: "refused", code: "tax_invalid_input", field: "/capturedAt",
      remedy: "The capture predates calculation. Reconcile the original payment and calculation." });
    expect(f.effects().commits).toBe(0);
  });

  it.each([{ payableMinor: 123 }, { currency: "XTS" }, { capturedAt: later }])("reconciles a verified capture that disagrees with its quote (%j)", async facts => {
    const f = lifecycleFixture();
    const port = f.open();
    const { commit, result } = await f.quoteAndReserve(port);
    f.reserveCommit(commit, result.money.payableMinor, facts);
    const refusal = await port.commit(commit);
    expectIntegrityRefusal(refusal);
    expect(refusal).toMatchObject({ field: "/captureEvidenceRef",
      remedy: "The verified capture differs from this quote. Replay the original binding or reconcile the original payment and calculation." });
    expect(f.effects().commits).toBe(0);
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
    const result = await port.commit(input);
    expect(result).toMatchObject({ kind: "refused", code });
    if (code === "tax_reference_conflict") {
      expectIntegrityRefusal(result);
      expect(f.lookup).not.toHaveBeenCalled();
    }
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
    const { f, port, input, units } = await postedLine();
    expect(await port.reverse({ ...input, mode: "amount", amountMinor: 40 })).toMatchObject({ code: "tax_operation_unsupported" });
    const fee = { ...input, feeEvidenceRef: "fee-evidence", positions: [{ ...input.positions[0], netDeltaMinor: -39, feeDeltaMinor: -1 }] };
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

  it("checks reservation integrity before timestamp, delta or amount-mode advice", async () => {
    const { f, port, commit, input, units } = await postedLine();
    expectIntegrityRefusal(await port.commit({ ...commit, postedAt: "invalid-instant" }));
    f.reserveReverse(input, units, 100);
    expectIntegrityRefusal(await port.reverse({ ...input, positions: [{ ...input.positions[0], netDeltaMinor: 1 }] }));
    expectIntegrityRefusal(await port.reverse({ ...input, mode: "amount", amountMinor: 40 }));
    expect(f.effects()).toEqual({ commits: 1, reversals: 0, providerCloses: 0 });
  });

  it("refuses a changed posted-line mapping under the original refund reservation", async () => {
    const { f, port, input, units } = await postedLine();
    f.reserveReverse(input, units, 100);
    units[0].postedPositionRef = "tax_other_line";
    f.lookup.mockClear();
    expectIntegrityRefusal(await port.reverse(input));
    expect(f.lookup).not.toHaveBeenCalled();
    expect(f.effects().reversals).toBe(0);
  });

  it("checks the persisted request digest before dispatch and recovery lookup", async () => {
    const { f, port, commit, input, units } = await postedLine();
    const refund = f.reserveReverse(input, units, 100);
    const sale = f.reservations.get(commit.transactionRef)!;
    sale.requestDigest = refund.requestDigest = "0".repeat(64);
    f.lookup.mockClear();
    for (const intent of ["apply", "recover"] as const) {
      expectIntegrityRefusal(await port.commit({ ...commit, intent }));
      expectIntegrityRefusal(await port.reverse({ ...input, intent }));
    }
    expect(f.lookup).not.toHaveBeenCalled();
    expect(f.effects()).toEqual({ commits: 1, reversals: 0, providerCloses: 0 });
  });

  it("returns typed failures when the reference index fails", async () => {
    const { f, port, commit, input, units } = await postedLine();
    f.reserveReverse(input, units, 100);
    f.lookup.mockImplementation(() => { throw new Error("Index unavailable"); });
    const unknown = { kind: "unavailable", code: "tax_adapter_unavailable", effect: "unknown" };
    expect(await port.commit({ ...commit, intent: "recover" })).toEqual(unknown);
    expect(await port.reverse(input)).toEqual({ ...unknown, effect: "none" });
    f.refunds.get(input.reversalRef)!.send = { kind: "unknown" };
    expect(await port.reverse(input)).toEqual(unknown);
    expect(f.effects()).toEqual({ commits: 1, reversals: 0, providerCloses: 0 });
  });

  it.each(["readSale", "readAccepted"] as const)("returns a typed no-effect failure when %s throws before a sale dispatch", async read => {
    const f = lifecycleFixture();
    const port = f.open();
    const { commit } = await f.quoteAndReserve(port);
    f[read].mockImplementation(() => { throw new Error("Host read unavailable"); });
    expect(await port.commit(commit)).toEqual({ kind: "unavailable", code: "tax_adapter_unavailable", effect: "none" });
    expect(f.lookup).not.toHaveBeenCalled();
    expect(f.effects().commits).toBe(0);
  });

  it("keeps a lost reversal unresolved when the refund reservation store throws during recovery", async () => {
    const { f, port, input, units } = await postedLine();
    f.reserveReverse(input, units, 100);
    f.loseResponse();
    const unknown = { kind: "unavailable", code: "tax_adapter_unavailable", effect: "unknown" };
    expect(await port.reverse(input)).toEqual(unknown);
    f.readRefund.mockImplementation(() => { throw new Error("Refund reservation store unavailable"); });
    f.lookup.mockClear();
    expect(await port.reverse({ ...input, intent: "recover" })).toEqual(unknown);
    expect(f.lookup).not.toHaveBeenCalled();
    expect(f.effects().reversals).toBe(1);
  });

  it("recovers a lost reversal response only after verifying the indexed receipt", async () => {
    const { f, port, input, units } = await postedLine();
    const reservation = f.reserveReverse(input, units, 100);
    f.loseResponse();
    expect(await port.reverse(input)).toEqual({ kind: "unavailable", code: "tax_adapter_unavailable", effect: "unknown" });
    reservation.send = { kind: "unknown" };
    const recover = { ...input, intent: "recover" as const };
    expect(await port.reverse(recover)).toMatchObject({ kind: "unavailable", effect: "unknown" });
    const [{ reference, metadata }] = f.client.transactions.createReversal.mock.calls[0];
    expect(metadata.openlup_request_digest).toMatch(/^[a-f0-9]{64}$/u);
    f.references.set(reference, "tax_sale");
    expect(await port.reverse(recover)).toMatchObject({ kind: "unavailable", effect: "unknown" });
    f.references.set(reference, "tax_refund_1");
    const stored = f.receipts.get("tax_refund_1")!;
    stored.metadata = { openlup_request_digest: reservation.requestDigest };
    expect(await port.reverse(recover)).toEqual({ kind: "unavailable", code: "tax_coverage_evidence_unavailable", effect: "unknown" });
    stored.metadata = metadata;
    expect(await port.reverse(recover)).toEqual({ kind: "reversed", providerReversalRef: "tax_refund_1", positions: input.positions });
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
  it("diagnoses invalid fiscal bindings before repair advice and leaves adapter validity unavailable without provider calls", async () => {
    const f = lifecycleFixture({ single: true });
    const port = f.open();
    const original = f.request();
    const result = await port.quote(original);
    if (result.kind !== "final") throw new Error("Expected final quote");
    const chargeAt = "2030-01-02T00:00:00.000Z";
    const scope = { ...original.input.scope, accountRef: "other-account" };
    const current = { ...original.input, taxDate: chargeAt, scope, coverage: { ...original.input.coverage, accountRef: scope.accountRef } };
    const request = { original, evidence: result.evidence, evidenceDigest: result.evidenceDigest, chargeAt, current };
    const forged = { ...request, evidenceDigest: "0".repeat(64) };
    const malformed = { ...request, evidence: { ...result.evidence, requestKey: "" } };
    const foreign = { ...request, chargeAt: later };
    const cases = [
      [forged, "tax_reference_conflict", "/evidenceDigest"],
      [malformed, "tax_invalid_input", "/evidence/requestKey"],
      [foreign, "tax_scope_mismatch", "/current/scope/accountRef"],
    ] as const;
    for (const [input, code, field] of cases) {
      const diagnostic = verifyTaxQuoteRequest(input);
      if (code !== "tax_invalid_input") expectIntegrityRefusal(diagnostic, code);
      expect(diagnostic).toMatchObject({ kind: "refused", code, field });
      expect(await port.readFiscalValidity(input)).toEqual({
        kind: "unavailable", code: "tax_fiscal_validity_unavailable", effect: "none",
      });
    }
    expect(f.client.calculations.create).toHaveBeenCalledTimes(1);
    expect(f.client.registrations.list).toHaveBeenCalledTimes(1);
    expect(f.client.calculations.retrieve).not.toHaveBeenCalled();
    expect(f.client.calculations.listLineItems).not.toHaveBeenCalled();
    expect(f.client.transactions.retrieve).not.toHaveBeenCalled();
    expect(f.client.transactions.listLineItems).not.toHaveBeenCalled();
    expect(f.effects()).toEqual({ commits: 0, reversals: 0, providerCloses: 0 });
  });

  it("refuses a verified probe that changes the frozen currency", async () => {
    const f = lifecycleFixture({ single: true });
    const boundRequest = f.request();
    const bound = await f.open().quote(boundRequest);
    const other = lifecycleFixture({ single: true });
    const taxDate = "2030-01-02T00:00:00.000Z";
    other.marketPack.currency = "XTS";
    other.setTime(taxDate);
    const probeRequest = makeTaxQuoteRequest(boundRequest.key, { ...boundRequest.input, taxDate, currency: "XTS" });
    const probe = await other.open().quote(probeRequest);
    expect(bound.kind).toBe("final");
    expect(probe.kind).toBe("final");
    expect(verifyTaxQuoteResult(probeRequest, probe)).toBeUndefined();
    expectIntegrityRefusal(compareTaxRecalculationProbe(boundRequest, bound, probeRequest, probe));
  });

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
    expectIntegrityRefusal(compareTaxRecalculationProbe(boundRequest, bound, { ...request, key: "different-key" }, result));
    expect(compareTaxRecalculationProbe(boundRequest, bound, boundRequest, bound)).toMatchObject({ kind: "refused" });
  });
});
