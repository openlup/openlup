import { describe, expect, it } from "vitest";
import {
  readCheckoutEvidence,
  readPaymentProviderRefs,
  readShippableAddresses,
  readSubscriptions,
  readSubscriptionAddressPointers,
} from "./customerJourneyEvidenceReads.js";

const CLIENT_ID = "10000000-0000-4000-8000-000000000001";
const HOME_ID = "a0000000-0000-4000-8000-000000000001";
const WORK_ID = "a0000000-0000-4000-8000-000000000002";
const INVOICE_ID = "a0000000-0000-4000-8000-000000000003";
const SUBSCRIPTION_ID = "30000000-0000-4000-8000-000000000003";

/** A read lane whose named tables answer, and whose unnamed ones fail. */
function reader(tables: Record<string, Array<Record<string, unknown>>>, selections: Array<{ table: string; columns: string }> = []) {
  const query = (table: string) => {
    const chain: Record<string, unknown> = {};
    const same = () => chain;
    const select = (columns: string) => {
      selections.push({ table, columns });
      return chain;
    };
    const result = () => tables[table]
      ? { data: tables[table], error: null }
      : { data: null, error: { message: "read_failed" } };
    Object.assign(chain, {
      select, eq: same, in: same, order: same,
      range: async () => result(),
      then: <TResult1 = unknown, TResult2 = never>(
        onfulfilled?: ((value: unknown) => TResult1 | PromiseLike<TResult1>) | null,
        onrejected?: ((reason: unknown) => TResult2 | PromiseLike<TResult2>) | null,
      ) => Promise.resolve(result()).then(onfulfilled, onrejected),
    });
    return chain;
  };
  return { from: (table: string) => query(table) } as never;
}

describe("customer journey evidence reads", () => {
  it("returns no provider refs when no order ids are available", async () => {
    await expect(readPaymentProviderRefs({} as never, [])).resolves.toMatchObject({ value: [], warnings: [] });
  });

  it("keeps failed ancillary reads distinct from observed empty rows", async () => {
    const checkout = await readCheckoutEvidence(reader({}), CLIENT_ID, [{ id: "order-1", status: "draft" }]);
    expect(checkout.value.recoveryTokens).toEqual([]);
    expect(checkout.value.abandonedCartEvents).toEqual([]);
    expect(checkout.warnings).toEqual([
      "evidence_unavailable:checkout_recovery_tokens",
      "evidence_unavailable:checkout_outbox",
    ]);

    const refs = await readPaymentProviderRefs(reader({}), [{ id: "order-1" }]);
    expect(refs.value).toEqual([]);
    expect(refs.warnings).toEqual(["evidence_unavailable:payment_provider_refs"]);
  });

  it("reads physical payment-reference columns and does not infer whether a reference is active", async () => {
    const selections: Array<{ table: string; columns: string }> = [];
    const refs = await readPaymentProviderRefs(reader({
      commerce_payments: [{ id: "payment-1", order_id: "order-1", provider: "provider", provider_payment_id: "payment-reference", status: "pending", updated_at: "2026-09-01T01:00:00.000Z" }],
      payment_external_refs: [{ payment_id: "payment-1", provider_kind: "provider", provider_payment_id: "external-reference", created_at: "2026-09-01T00:00:00.000Z" }],
    }, selections), [{ id: "order-1" }]);

    expect(selections).toContainEqual({ table: "payment_external_refs", columns: "payment_id, provider_kind, provider_payment_id, created_at" });
    expect(refs).toEqual({ value: [
      { orderId: "order-1", paymentId: "payment-1", provider: "provider", providerPaymentId: "payment-reference", status: "pending", updatedAt: "2026-09-01T01:00:00.000Z" },
      { paymentId: "payment-1", providerKind: "provider", externalRef: "external-reference", active: null, updatedAt: "2026-09-01T00:00:00.000Z" },
    ], warnings: [] });
  });

  it("fails closed when the mandatory subscription list cannot be read", async () => {
    await expect(readSubscriptions(reader({}), CLIENT_ID, [])).rejects.toThrow("customer_journey_subscription_list_unavailable");
  });

  it("does not infer missing cycles from a source-capped subscription history", async () => {
    const subscriptions = await readSubscriptions(reader({
      subscriptions: [{ id: SUBSCRIPTION_ID, status: "active", next_cycle_at: "2026-09-01T00:00:00.000Z" }],
      subscription_cycles: Array.from({ length: 30 }, () => ({ subscription_id: "another-subscription" })),
      commerce_orders: [], commerce_payment_method_refs: [], communication_email_deliveries: [],
    }), CLIENT_ID, []);

    expect(subscriptions.warnings).toContain("evidence_window_limited:subscription_cycles");
    expect(subscriptions.value[0]?.gaps.map((gap) => gap.code)).not.toContain("subscription_cycles_missing");
  });

  it("does not select the absent payment-method last-used field", async () => {
    const selections: Array<{ table: string; columns: string }> = [];
    await readSubscriptions(reader({
      subscriptions: [{ id: SUBSCRIPTION_ID, status: "active", next_cycle_at: "2026-09-01T00:00:00.000Z" }],
      subscription_cycles: [], commerce_orders: [], commerce_payment_method_refs: [], communication_email_deliveries: [],
    }, selections), CLIENT_ID, []);

    expect(selections).toContainEqual({ table: "commerce_payment_method_refs", columns: "id, client_id, subscription_id, provider_kind, status, active, created_at, updated_at" });
  });

  it("offers only shippable addresses, default first and then most recently used", async () => {
    const addresses = await readShippableAddresses(reader({
      addresses: [
        { id: WORK_ID, kind: "both", line1: "Work 2", postal_code: "00-003", city: "Seatown", country: "XX", is_default: false, last_used_at: "2026-08-10T00:00:00.000Z" },
        { id: INVOICE_ID, kind: "billing", line1: "Invoice 1", postal_code: "00-001", city: "Northtown", country: "XX", is_default: true },
        { id: HOME_ID, kind: "shipping", label: "Home", recipient_name: "Ada Example", line1: "Flower 1", line2: "flat 3", postal_code: "00-002", city: "Southtown", country: "XX", contact_phone: "+48123456789", is_default: true, last_used_at: "2026-08-01T00:00:00.000Z" },
        { id: "no-street", kind: "shipping", line1: null, postal_code: "00-004", city: "Midtown", country: "XX", is_default: false },
      ],
    }), CLIENT_ID);
    expect(addresses).toEqual([
      { addressId: HOME_ID, label: "Home", recipientName: "Ada Example", line1: "Flower 1", line2: "flat 3", postalCode: "00-002", city: "Southtown", country: "XX", contactPhone: "+48123456789", isDefault: true, kind: "shipping" },
      { addressId: WORK_ID, label: null, recipientName: null, line1: "Work 2", line2: null, postalCode: "00-003", city: "Seatown", country: "XX", contactPhone: null, isDefault: false, kind: "both" },
    ]);
  });

  it("says nothing rather than none when the addresses were never read", async () => {
    await expect(readShippableAddresses(reader({ addresses: [] }), null)).resolves.toBeNull();
    await expect(readShippableAddresses(reader({}), CLIENT_ID)).resolves.toBeNull();
    await expect(readShippableAddresses(reader({ addresses: [] }), CLIENT_ID)).resolves.toEqual([]);
  });

  it("maps each subscription to the address its next parcel uses, and nothing when unread", async () => {
    await expect(readSubscriptionAddressPointers(reader({
      subscriptions: [
        { id: SUBSCRIPTION_ID, shipping_address_id: HOME_ID },
        { id: "unrouted", shipping_address_id: null },
        { id: null, shipping_address_id: WORK_ID },
      ],
    }), CLIENT_ID)).resolves.toEqual(new Map([[SUBSCRIPTION_ID, HOME_ID], ["unrouted", null]]));
    await expect(readSubscriptionAddressPointers(reader({}), CLIENT_ID)).resolves.toBeNull();
    await expect(readSubscriptionAddressPointers(reader({ subscriptions: [] }), null)).resolves.toBeNull();
  });
});
