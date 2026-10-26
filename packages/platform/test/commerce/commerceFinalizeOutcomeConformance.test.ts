import { afterEach, describe, expect, it, vi } from "vitest";
import { createPorts, createResponse, intent, request, quoteSnapshot } from "./checkoutTestFixtures.js";
import { makeInventoryPort, makeOrderPort, makePaymentPort, makeReadinessPort } from "./checkoutTestFixtures.js";

afterEach(() => vi.restoreAllMocks());
async function fixture() {
  const [{ createCommerceCheckoutHandler }, { createCommerceRuntimeService }] = await Promise.all([
    import("./checkoutTestFixtures.js"), import("./checkoutTestFixtures.js")]);
  vi.spyOn(console, "info").mockImplementation(() => {});
  const ports = createPorts(), orderPort = makeOrderPort(), inventoryPort = makeInventoryPort();
  const paymentPort = makePaymentPort();
  paymentPort.applyResult.mockResolvedValue({ paymentIntentId: "88888888-8888-4888-8888-888888888888",
    paymentId: "99999999-9999-4999-8999-999999999999", paymentAttemptId: "55555555-5555-4555-8555-555555555555",
    orderId: "11111111-1111-4111-8111-111111111111", status: "succeeded", kind: "applied", replayed: false });
  const execute = vi.fn().mockResolvedValue({ provider: "hidden_rehearsal", providerAttemptId: null,
    providerSessionId: null, attemptStatus: "processing", nextActionKind: null, requestPayload: {}, responsePayload: {} });
  ports.runtimePort = createCommerceRuntimeService({ orderPort, inventoryPort, paymentPort,
    readinessPort: makeReadinessPort(), executionPort: { execute } });
  const run = async (extra = {}) => {
    const res = createResponse();
    await createCommerceCheckoutHandler(ports)(request("POST", { intent: intent(), paymentProvider: "hidden_rehearsal", ...extra }), res);
    return { status: vi.mocked(res.status).mock.calls.at(-1)?.[0], body: vi.mocked(res.json).mock.calls.at(-1)?.[0] };
  };
  return { ports, orderPort, inventoryPort, paymentPort, execute, run };
}
describe("commerce finalize outcome conformance", () => {
  it("projects the finalized aggregate through the paid checkout envelope", async () => {
    const f = await fixture(), result = await f.run();
    expect(result).toMatchObject({ status: 200, body: { ok: true, data: { status: "paid", checkoutKind: "one_time",
      orderId: "11111111-1111-4111-8111-111111111111", subscription: { requested: false, activationStatus: "not_applicable" } } } });
    expect(f.paymentPort.applyResult).toHaveBeenCalledOnce();
    expect(f.orderPort.finalizeOrderForCheckout).toHaveBeenCalledWith(expect.objectContaining({ idempotencyKey: intent().idempotencyKey }));
  });
  it("returns a new quote before finalization when the accepted total changed", async () => {
    const f = await fixture();
    vi.mocked(f.ports.quotePort.createQuote).mockResolvedValue(quoteSnapshot({ amountMinor: 1600, currency: "XTS" }));
    expect(await f.run({ expectedQuote: { totalGross: { amountMinor: 1490, currency: "XTS" } } }))
      .toMatchObject({ status: 200, body: { ok: true, data: { status: "price_changed", priceChanged: true } } });
    expect(f.orderPort.finalizeOrderForCheckout).not.toHaveBeenCalled();
    expect(f.execute).not.toHaveBeenCalled();
  });
  it("composes stock refusal with cleanup before exposing the conflict", async () => {
    const f = await fixture();
    f.inventoryPort.reserveOrderItems.mockRejectedValue(new Error("Inventory reservation conflict"));
    expect(await f.run()).toMatchObject({ status: 409, body: { ok: false, error: { code: "CONFLICT", details: { reason: "stock_unavailable" } } } });
    expect(f.ports.compensationPort.cancelAbandonedOrder).toHaveBeenCalledOnce();
    expect(f.paymentPort.createIntent).not.toHaveBeenCalled();
  });
  it("projects a synchronous decline as failed without settling success or releasing the recoverable hold", async () => {
    const f = await fixture();
    f.paymentPort.applyResult.mockResolvedValue({ paymentIntentId: "88888888-8888-4888-8888-888888888888",
      paymentId: "99999999-9999-4999-8999-999999999999", paymentAttemptId: "55555555-5555-4555-8555-555555555555",
      orderId: "11111111-1111-4111-8111-111111111111", status: "failed", kind: "recoverable_decline", replayed: false });
    f.execute.mockResolvedValue({ provider: "hidden_rehearsal", providerAttemptId: null, providerSessionId: null,
      attemptStatus: "processing", nextActionKind: null, requestPayload: {}, responsePayload: {}, providerDecline: { code: "declined", mandateUnsupported: false } });
    expect(await f.run()).toMatchObject({ status: 200, body: { ok: true, data: { status: "failed" } } });
    expect(f.paymentPort.applyResult).toHaveBeenCalledOnce();
    expect(f.paymentPort.applyResult).toHaveBeenCalledWith(expect.objectContaining({ resultStatus: "failed" }));
    expect(f.inventoryPort.releaseOrderReservations).not.toHaveBeenCalled();
    expect(f.ports.compensationPort.cancelAbandonedOrder).not.toHaveBeenCalled();
  });
  it("keeps admission busy retryable without exposing compensation capability", async () => {
    const f = await fixture();
    const { InventoryPersistenceError } = await import("../../src/inventory/index.js");
    f.inventoryPort.reserveOrderItems.mockRejectedValue(new InventoryPersistenceError("busy", { code: "55P03", reason: "inventory_admission_busy" }));
    expect(await f.run()).toMatchObject({ status: 503, body: { ok: false, error: { code: "UPSTREAM_UNAVAILABLE", details: { reason: "inventory_admission_busy" } } } });
    expect(f.ports.compensationPort.releaseOrderReservations).not.toHaveBeenCalled();
    expect(f.execute).not.toHaveBeenCalled();
  });
});
