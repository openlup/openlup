import { describe, expect, it, vi } from "vitest";
import { CHECKOUT_COMMAND_V1 } from "../../src/commerce/index.js";
import { CommerceRuntimeConflictError, CommerceRuntimePersistenceError } from "../../src/commerce/index.js";
import { createCommerceRuntimeService, makeOrderPort, makeInventoryPort, makePaymentPort, makeReadinessPort, quoteSnapshot, CLIENT_ID, ADDRESS_ID } from "./checkoutTestFixtures.js";
function fixture(currency = "XTS") {
  const quote = quoteSnapshot({ amountMinor: 1490, currency });
  const quotePort = { createQuote: vi.fn(async () => quote) }, persistencePort = { persistCheckoutCommand: vi.fn(async () => ({ idempotencyKey: "command-a", clientId: CLIENT_ID, shippingAddressId: ADDRESS_ID, subjectId: null, replayed: false })) };
  const orderDraftPort = { createOrderDraft: vi.fn(async () => ({ contractVersion: "commerce.v0", orderDraft: { orderId: `order_${CLIENT_ID}`, status: "draft" as const, paymentStatus: "not_started" as const, idempotencyKey: "command-a", quoteSnapshot: quote, replayed: false } })) };
  const execute = vi.fn(async () => ({ provider: "hidden_rehearsal" as const, providerAttemptId: null, providerSessionId: null, attemptStatus: "processing" as const, nextActionKind: null, requestPayload: {}, responsePayload: {} }));
  const runtime = { orderPort: makeOrderPort(), inventoryPort: makeInventoryPort(), paymentPort: makePaymentPort(), readinessPort: makeReadinessPort() };
  const deps = { ...runtime, quotePort, persistencePort, orderDraftPort, resolveExecutionPort: vi.fn(() => ({ execute })) };
  const command = { version: CHECKOUT_COMMAND_V1 as typeof CHECKOUT_COMMAND_V1, idempotencyKey: "command-a", mode: "subscription" as const, cadenceDays: 21, lines: [{ sku: "ITEM-A", quantity: 14 }], customer: { firstName: "Buyer", lastName: "Example", email: "buyer@example.test", phone: "123456789" }, shippingAddress: { street: "Example 12", postalCode: "00000", city: "Example", country: "AA" }, currency: "XTS" };
  return { deps, command, execute };
}
describe("neutral checkout command", () => {
  it("uses the shared saga once, propagates its captured results and settles only rehearsal success", async () => {
    const f = fixture(); const result = await createCommerceRuntimeService(f.deps).startCheckoutCommand({ command: f.command, paymentProvider: "hidden_rehearsal" });
    expect(f.deps.quotePort.createQuote).toHaveBeenCalledOnce(); expect(f.deps.persistencePort.persistCheckoutCommand).toHaveBeenCalledOnce(); expect(f.deps.orderDraftPort.createOrderDraft).toHaveBeenCalledOnce(); expect(f.deps.orderPort.finalizeOrderForCheckout).toHaveBeenCalledOnce(); expect(f.execute).toHaveBeenCalledOnce(); expect(f.deps.paymentPort.applyResult).toHaveBeenCalledOnce();
    expect(result.runtime).toMatchObject({ runtime: { orderId: CLIENT_ID } });
    expect(result.settlement?.paymentResult.status).toBe("succeeded"); expect(result.persistence.subjectId).toBeNull();
    expect(f.deps.orderPort.finalizeOrderForCheckout).toHaveBeenCalledWith(expect.objectContaining({ mode: "subscription_cycle", metadata: expect.objectContaining({ checkoutCommandVersion: CHECKOUT_COMMAND_V1, cadenceDays: 21, deliveryContact: expect.objectContaining({ contactEmail: "buyer@example.test" }) }) }));
  });
  it("rejects a currency mismatch before every persistence or runtime side effect", async () => {
    const f = fixture("XXX"); await expect(createCommerceRuntimeService(f.deps).startCheckoutCommand({ command: f.command, paymentProvider: "hidden_rehearsal" })).rejects.toBeInstanceOf(CommerceRuntimeConflictError);
    expect(f.deps.persistencePort.persistCheckoutCommand).not.toHaveBeenCalled(); expect(f.deps.orderDraftPort.createOrderDraft).not.toHaveBeenCalled(); expect(f.deps.orderPort.finalizeOrderForCheckout).not.toHaveBeenCalled();
  });
  it("refuses an incomplete composition before quote, draft or payment", async () => {
    const f = fixture(); await expect(createCommerceRuntimeService({ ...f.deps, persistencePort: undefined }).startCheckoutCommand({ command: f.command, paymentProvider: "hidden_rehearsal" })).rejects.toBeInstanceOf(CommerceRuntimePersistenceError);
    expect(f.deps.quotePort.createQuote).not.toHaveBeenCalled(); expect(f.execute).not.toHaveBeenCalled();
  });
});
