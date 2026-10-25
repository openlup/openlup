import { describe, expect, it, vi } from "vitest";
import * as core from "@openlup/platform/commerce/server";
import * as sweep from "../../adapters/managed/commerce/reservationSweepPort.js";
import * as compensation from "../../adapters/supabase/commerce/checkoutCompensation.js";
import * as token from "./checkoutRecoveryToken.js";
import { mapRpcError, createManagedCommerceRuntimeOrderPort } from "../../adapters/managed/commerce/commerceRuntimePort.js";
import { createSupabaseCommerceOrderDraftPort } from "../../adapters/supabase/commerceOrderDraft.js";
import { createSupabaseConfiguratorIntentPersistencePort } from "../../adapters/supabase/configuratorIntentPersistence.js";
import { createSupabaseCommerceCheckoutResumePort } from "../../adapters/supabase/commerceCheckoutResume.js";
import { createOrderDraftRpcArgs, orderDraftRpcArgsSchema } from "./orderDraftRpcPayload.js";
import { createOrderDraftSnapshotFromQuoteSnapshot, orderDraftSnapshotSchema } from "../../../src/domains/commerce/orderDraftSnapshotContracts.js";
import { createQuoteResponseSchema, createOrderDraftResponseSchema } from "../../../src/domains/commerce/contracts.js";
import { checkoutResumeDraftSchema } from "../../../src/domains/commerce/checkoutResumeContracts.js";
import { configuratorIntentPersistenceResponseSchema } from "../../../src/domains/commerce/configuratorIntentPersistenceContracts.js";
import { orderDraftSummary, makeOrderPort } from "./commerceRuntimeService.fixtures.js";
import type { StartHiddenCheckoutRuntimeRequest } from "../../../src/domains/commerce/runtimeContracts.js";
import { classifyOrderRecoveryEligibility } from "./checkoutExpiredRecoveryPolicy.js";

describe("checkout store facades", () => {
  it("keeps leaf export identity", () => {
    expect(sweep.createManagedReservationSweepPort).toBe(core.createManagedReservationSweepPort);
    expect(compensation.createSupabaseCheckoutCompensationAdapter).toBe(core.createSupabaseCheckoutCompensationAdapter);
    expect(compensation.cancelAbandonedCheckout).toBe(core.cancelAbandonedCheckout);
    expect(compensation.cancelUnstartedPromotionCheckout).toBe(core.cancelUnstartedPromotionCheckout);
    expect(token.hashCheckoutRecoveryToken).toBe(core.hashCheckoutRecoveryToken);
    expect(token.generateCheckoutRecoveryToken).toBe(core.generateCheckoutRecoveryToken);
    expect(token.classifyCheckoutRecoveryTokenState).toBe(core.classifyCheckoutRecoveryTokenState);
    expect(mapRpcError).toBe(core.mapCommerceFinalizeRpcError);
  });
  it("binds the exact incumbent draft schemas and payload projection", async () => {
    const input = { idempotencyKey: "journey-example", quoteSnapshot: orderDraftSummary().quoteSnapshot };
    const expected = core.createOrderDraftRpcPayload({ quoteSchema: createQuoteResponseSchema, draftSchema: orderDraftSnapshotSchema, createSnapshot: createOrderDraftSnapshotFromQuoteSnapshot });
    expect(createOrderDraftRpcArgs(input)).toEqual(expected.createOrderDraftRpcArgs(input));
    expect(orderDraftRpcArgsSchema.parse(createOrderDraftRpcArgs(input))).toEqual(expected.orderDraftRpcArgsSchema.parse(createOrderDraftRpcArgs(input)));
    const data = { contractVersion: "commerce.v0", orderDraft: orderDraftSummary() };
    const rpc = vi.fn().mockResolvedValue({ data, error: null });
    const actual = await createSupabaseCommerceOrderDraftPort({ rpc }).createOrderDraft(input);
    expect(actual).toEqual(createOrderDraftResponseSchema.parse(data));
    expect(rpc).toHaveBeenCalledExactlyOnceWith(core.ORDER_DRAFT_RPC_NAME, expected.createOrderDraftRpcArgs(input));
  });
  it("keeps finalize SQL argument names and insertion order at the host binding", async () => {
    const order = await makeOrderPort().finalizeOrderForCheckout();
    const rpc = vi.fn().mockResolvedValue({ data: { contractVersion: "commerce.v0", finalizedOrder: order }, error: null });
    const input: StartHiddenCheckoutRuntimeRequest = { idempotencyKey: "journey-example", orderDraft: orderDraftSummary(), mode: "one_time", clientId: order.clientId, shippingAddressId: order.shippingAddressId, paymentProvider: "hidden_rehearsal", providerFlow: "one_time_payment", metadata: { source: "ignored" } };
    expect(await createManagedCommerceRuntimeOrderPort({ rpc }).finalizeOrderForCheckout(input)).toBe(order);
    const args = rpc.mock.calls[0][1];
    expect(Object.keys(args)).toEqual(["p_idempotency_key", "p_order_id", "p_mode", "p_client_id", "p_shipping_address_id", "p_pet_id", "p_quote_snapshot", "p_order_draft_snapshot", "p_metadata"]);
    expect(args).toEqual({ p_idempotency_key: input.idempotencyKey, p_order_id: input.orderDraft.orderId.replace(/^order_/, ""), p_mode: input.mode, p_client_id: input.clientId, p_shipping_address_id: input.shippingAddressId, p_pet_id: null, p_quote_snapshot: input.orderDraft.quoteSnapshot, p_order_draft_snapshot: createOrderDraftSnapshotFromQuoteSnapshot(input.orderDraft.quoteSnapshot), p_metadata: { source: "commerce.runtime.hidden.v0" } });
  });
  it("binds host persistence response decoding to the package store", async () => {
    const data = { contractVersion: "commerce.configurator_intent_persistence.v1", intentVersion: "commerce.configurator_intent.v1", idempotencyKey: "journey-example", clientId: "11111111-1111-4111-8111-111111111111", petId: "22222222-2222-4222-8222-222222222222", addressId: "33333333-3333-4333-8333-333333333333", clientMatchReason: "client_match_exact_email", replayed: false };
    const rpc = vi.fn().mockResolvedValue({ data, error: null });
    const input = { idempotencyKey: "journey-example" } as never;
    expect(await createSupabaseConfiguratorIntentPersistencePort({ rpc } as never).persistIntent(input)).toEqual(configuratorIntentPersistenceResponseSchema.parse(data));
    expect(rpc.mock.calls[0][1]).toEqual({ p_intent: { idempotencyKey: "journey-example", authenticatedUserId: null } });
  });
  it("binds the host resume schema and preserves active-read filters", async () => {
    const state = { version: "commerce.checkout_resume.v1", mode: "one_time", cadenceDays: null, cart: { items: [] }, completion: { petProfile: false, productSelection: false, cadence: false, account: false, shipping: false, billing: false, payment: false, review: true }, redactedFields: ["contact"] };
    const data = { id: "11111111-1111-4111-8111-111111111111", last_section_id: "review", draft_state: state, expires_at: "1999-01-02T00:00:00.000Z", created_at: "1999-01-01T00:00:00.000Z", updated_at: "1999-01-01T00:00:00.000Z" };
    const chain = { select: vi.fn(), eq: vi.fn(), is: vi.fn(), gt: vi.fn(), maybeSingle: vi.fn().mockResolvedValue({ data, error: null }) };
    for (const fn of [chain.select, chain.eq, chain.is, chain.gt]) fn.mockReturnValue(chain);
    const result = await createSupabaseCommerceCheckoutResumePort({ from: () => chain } as never).readDraftByTokenHash({ tokenHash: "example-hash", now: data.created_at });
    expect(result).toEqual(checkoutResumeDraftSchema.parse({ id: data.id, contractVersion: state.version, lastSectionId: data.last_section_id, draftState: state, expiresAt: data.expires_at, createdAt: data.created_at, updatedAt: data.updated_at, replayed: true }));
    expect(chain.is).toHaveBeenCalledWith("revoked_at", null);
    expect(chain.gt).toHaveBeenCalledWith("expires_at", data.created_at);
  });
  it("injects only the persisted neutral-command subject exception into recovery", () => {
    const order = { status: "expired", createdAt: "1999-01-01T00:00:00.000Z", technicallyExpired: true, quoteSnapshot: orderDraftSummary().quoteSnapshot, shippingAddressId: "address-a", mode: "subscription_cycle", subscriptionId: "subscription-a", subscriptionCycleId: "cycle-a", petId: null } as never;
    expect(classifyOrderRecoveryEligibility(order, new Date("1999-01-02T00:00:00.000Z"))).toEqual({ kind: "unavailable" });
    expect(classifyOrderRecoveryEligibility({ ...order as object, runtimeMetadata: { checkoutCommandVersion: "commerce.checkout_command.v1" } } as never, new Date("1999-01-02T00:00:00.000Z"))).toEqual({ kind: "eligible" });
  });
});
