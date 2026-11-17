import { describe, expect, it, vi } from "vitest";
import { CHECKOUT_COMMAND_V1 } from "../../src/commerce/index.js";
import { CommerceRuntimeConflictError, CommerceRuntimePersistenceError } from "../../src/commerce/index.js";
import { z } from "zod";
import { createConfiguratorIntentPersistenceRpcPort } from "../../src/commerce/server/index.js";
import { configuratorIntentReplayFingerprint } from "../../src/commerce/server/configuratorIntentReplayFingerprint.js";
import type { CheckoutCommandV1, CheckoutCommandPersistenceResult } from "../../src/commerce/checkoutCommandSchemas.js";
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
  function replayFixture(days: number, completed: boolean) {
    const f = fixture(); f.command.cadenceDays = days;
    const quote = quoteSnapshot();
    f.command.lines = quote.quote.lines.map(({ sku, quantity }) => ({ sku, quantity }));
    quote.quote.context = { mode: "subscription", cadenceDays: days, promoCodes: [] };
    const identity = { idempotencyKey: f.command.idempotencyKey, clientId: CLIENT_ID, shippingAddressId: ADDRESS_ID, subjectId: null, replayed: false };
    const row = { response_payload: identity, request_fingerprint: configuratorIntentReplayFingerprint({ ...f.command, authenticatedUserId: null }) as string | null };
    const draft = { response_payload: { orderDraft: { quoteSnapshot: quote } }, invalidated_at: null as string | null };
    const from = vi.fn((table: string) => {
      const query = { eq: vi.fn(() => query), limit: vi.fn(async () => ({ data: completed ? [table === "commerce_idempotency_keys" ? row : draft] : [], error: null })) };
      return { select: vi.fn(() => query) };
    });
    const rpc = vi.fn(async () => ({ data: identity, error: null }));
    const persistence = createConfiguratorIntentPersistenceRpcPort<object, object, CheckoutCommandV1, CheckoutCommandPersistenceResult, typeof quote>({ from, rpc }, {
      responseSchema: z.object({}), decodeCommandResponse: data => z.object({ idempotencyKey: z.string(), clientId: z.string(), shippingAddressId: z.string(), subjectId: z.null(), replayed: z.boolean() }).parse(data),
      decodeCommandQuote: data => z.custom<typeof quote>().parse(data), normalizePhoneToE164: phone => phone,
    });
    const persistCheckoutCommand = vi.spyOn(persistence, "persistCheckoutCommand");
    const deps = { ...f.deps, persistencePort: persistence };
    return { ...f, deps, from, row, draft, rpc, persistCheckoutCommand };
  }
  it("authenticates a completed 3661-day command before reusing its stored quote", async () => {
    const f = replayFixture(3661, true);
    f.deps.quotePort.createQuote.mockRejectedValue(new Error("fresh quote must not run"));
    const result = await createCommerceRuntimeService(f.deps).startCheckoutCommand({ command: f.command, paymentProvider: "hidden_rehearsal" });
    expect(result.persistence.replayed).toBe(true);
    expect(result.quoteSnapshot.quote.context?.cadenceDays).toBe(3661);
    expect(f.from.mock.calls.map(([table]) => table)).toEqual(["commerce_idempotency_keys", "commerce_order_draft_receipts"]);
    expect(f.deps.quotePort.createQuote).not.toHaveBeenCalled();
    expect(f.persistCheckoutCommand).not.toHaveBeenCalled(); expect(f.rpc).not.toHaveBeenCalled();
    expect(f.from.mock.invocationCallOrder[1]).toBeLessThan(f.deps.resolveExecutionPort.mock.invocationCallOrder[0]);
  });
  it("refuses a fresh 3661-day command after SELECT and before every fresh dependency or write", async () => {
    const f = replayFixture(3661, false);
    await expect(createCommerceRuntimeService(f.deps).startCheckoutCommand({ command: f.command, paymentProvider: "hidden_rehearsal" })).rejects.toMatchObject({ details: { reason: "cadence_limit_exceeded" } });
    expect(f.from).toHaveBeenCalledOnce();
    expect(f.persistCheckoutCommand).not.toHaveBeenCalled(); expect(f.rpc).not.toHaveBeenCalled();
    expect(f.deps.quotePort.createQuote).not.toHaveBeenCalled(); expect(f.deps.resolveExecutionPort).not.toHaveBeenCalled();
    expect(f.deps.orderDraftPort.createOrderDraft).not.toHaveBeenCalled(); expect(f.deps.orderPort.finalizeOrderForCheckout).not.toHaveBeenCalled(); expect(f.execute).not.toHaveBeenCalled();
  });
  it.each([21, 3661])("refuses a conflicting completed %i-day command before quotes or writes", async days => {
    const f = replayFixture(days, true); f.command.customer.firstName = "Changed";
    await expect(createCommerceRuntimeService(f.deps).startCheckoutCommand({ command: f.command, paymentProvider: "hidden_rehearsal" })).rejects.toMatchObject({ name: "ConfiguratorIntentPersistenceConflictError", details: { code: "23505" } });
    expect(f.from).toHaveBeenCalledOnce(); expect(f.rpc).not.toHaveBeenCalled(); expect(f.persistCheckoutCommand).not.toHaveBeenCalled();
    expect(f.deps.quotePort.createQuote).not.toHaveBeenCalled(); expect(f.deps.resolveExecutionPort).not.toHaveBeenCalled(); expect(f.execute).not.toHaveBeenCalled();
  });
  it.each(["missing draft", "invalidated draft", "missing fingerprint"])("does not admit historical work with %s", async kind => {
    const f = replayFixture(3661, true);
    if (kind === "missing fingerprint") f.row.request_fingerprint = null;
    else if (kind === "invalidated draft") f.draft.invalidated_at = "1999-01-01T00:00:00Z";
    else f.draft.response_payload.orderDraft.quoteSnapshot = undefined as never;
    await expect(createCommerceRuntimeService(f.deps).startCheckoutCommand({ command: f.command, paymentProvider: "hidden_rehearsal" })).rejects.toThrow();
    expect(f.rpc).not.toHaveBeenCalled(); expect(f.deps.quotePort.createQuote).not.toHaveBeenCalled(); expect(f.execute).not.toHaveBeenCalled();
  });
  it.each(["cadence", "mode", "lines"])("refuses a retained quote with mismatched %s before any fresh effects", async kind => {
    const f = replayFixture(3661, true);
    const quote = f.draft.response_payload.orderDraft.quoteSnapshot.quote;
    if (kind === "cadence") quote.context!.cadenceDays = 21;
    else if (kind === "mode") quote.context!.mode = "one_time";
    else quote.lines[0].quantity += 1;
    await expect(createCommerceRuntimeService(f.deps).startCheckoutCommand({ command: f.command, paymentProvider: "hidden_rehearsal" })).rejects.toBeInstanceOf(CommerceRuntimeConflictError);
    expect(f.rpc).not.toHaveBeenCalled(); expect(f.deps.quotePort.createQuote).not.toHaveBeenCalled(); expect(f.deps.resolveExecutionPort).not.toHaveBeenCalled(); expect(f.execute).not.toHaveBeenCalled();
  });
  it("preserves completed one-time quotes without an optional context", async () => {
    const f = replayFixture(21, true);
    const command: CheckoutCommandV1 = { ...f.command, mode: "one_time" }; delete command.cadenceDays;
    delete f.draft.response_payload.orderDraft.quoteSnapshot.quote.context;
    f.row.request_fingerprint = configuratorIntentReplayFingerprint({ ...command, authenticatedUserId: null });
    const result = await createCommerceRuntimeService(f.deps).startCheckoutCommand({ command, paymentProvider: "hidden_rehearsal" });
    expect(result.persistence.replayed).toBe(true); expect(f.deps.quotePort.createQuote).not.toHaveBeenCalled(); expect(f.rpc).not.toHaveBeenCalled();
  });
  it.each([1, 3660])("admits fresh %i-day work after replay lookup and quotes before persistence", async days => {
    const f = replayFixture(days, false);
    await createCommerceRuntimeService(f.deps).startCheckoutCommand({ command: f.command, paymentProvider: "hidden_rehearsal" });
    expect(f.from).toHaveBeenCalledOnce(); expect(f.deps.quotePort.createQuote).toHaveBeenCalledOnce(); expect(f.rpc).toHaveBeenCalledOnce();
    expect(f.from.mock.invocationCallOrder[0]).toBeLessThan(f.deps.quotePort.createQuote.mock.invocationCallOrder[0]);
    expect(f.deps.quotePort.createQuote.mock.invocationCallOrder[0]).toBeLessThan(f.rpc.mock.invocationCallOrder[0]);
  });
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
