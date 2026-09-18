import { describe, expect, it } from "vitest";
import { deliveryContactFixture } from "../../../src/domains/commerce/omsClient.fixtures.js";
import {
  OMNIPACK_DISPATCH_CANDIDATE_SELECT,
  omnipackDispatchCandidateIds,
  providerOrderNumberFor,
  toOmnipackDispatchCandidate,
  toOmnipackDispatchReadBack,
  toOmnipackDispatchReadBackFromRpc,
  type OmnipackDispatchCandidateRow,
} from "./omnipackDispatchMappers.js";

describe("Supabase OmniPack dispatch mappers", () => {
  it("hydrates a dispatch candidate through the established delivery resolver", () => {
    const row = candidateRow();

    expect(toOmnipackDispatchCandidate(row)).toMatchObject({
      fulfillmentOrderId: "fulfillment-1",
      orderId: "order-1",
      client: {
        email: "customer@example.test",
        firstName: "Test",
        lastName: "Customer",
        phone: "+48111111111",
      },
      deliveryContact: {
        source: "checkout_submission",
        revision: 1,
        contactEmail: "frozen@example.test",
        contactPhone: "+48222222222",
      },
      deliverySelection: {
        providerKind: "other",
        serviceCode: "ORDER_SERVICE",
      },
    });
  });

  it("carries the frozen recipient off the snapshot, and reports its absence as absence", () => {
    const row = candidateRow();
    const contact = row.shipping_address_snapshot.deliveryContact as Record<string, unknown>;
    contact.recipientName = "Marzena Podgorna";

    expect(toOmnipackDispatchCandidate(row).deliveryContact).toMatchObject({
      recipientName: "Marzena Podgorna",
    });

    delete contact.recipientName;
    expect(toOmnipackDispatchCandidate(row).deliveryContact?.recipientName).toBeNull();
  });

  it("does not let a live client or address-book selection replace a new-format parcel contact", () => {
    const row = candidateRow();
    row.clients = {
      email: "changed@example.test",
      first_name: "Changed",
      last_name: "Profile",
      phone: "+48999999999",
    };
    row.addresses = { metadata: { selectedDelivery: { providerKind: "changed" } } };

    expect(toOmnipackDispatchCandidate(row).deliveryContact).toMatchObject({
      source: "checkout_submission",
      recipientName: "Frozen Recipient",
      contactEmail: "frozen@example.test",
      contactPhone: "+48222222222",
      selectedDelivery: { providerKind: "other", serviceCode: "ORDER_SERVICE" },
    });
  });

  it("labels the live-row fallback for a historical parcel as inferred", () => {
    const row = candidateRow();
    delete row.shipping_address_snapshot.deliveryContact;

    expect(toOmnipackDispatchCandidate(row).deliveryContact).toMatchObject({
      schemaVersion: 1,
      source: "legacy_inferred",
      revision: 1,
      recipientName: "Test Customer",
      contactEmail: "customer@example.test",
      contactPhone: "+48111111111",
    });
  });

  it("normalizes readbacks, candidate ids and malformed nested evidence deterministically", () => {
    expect(toOmnipackDispatchReadBack({
      id: "ref-1",
      fulfillment_order_id: "fulfillment-1",
      order_id: "order-1",
      provider_order_id: 123,
      dispatch_mode: "stage",
      status: "created",
      request_idempotency_key: "dispatch-key",
      sanitized_request: ["not", "an", "object"],
    })).toEqual({
      id: "ref-1",
      fulfillment_order_id: "fulfillment-1",
      order_id: "order-1",
      provider_order_id: null,
      dispatch_mode: "stage",
      status: "created",
      request_idempotency_key: "dispatch-key",
      sanitized_request: {},
    });
    expect(toOmnipackDispatchReadBackFromRpc({
      dispatchRefId: "ref-2",
      fulfillmentOrderId: "fulfillment-2",
      orderId: "order-2",
      providerOrderId: "provider-2",
      dispatchMode: "live",
      status: "uncertain",
      requestIdempotencyKey: "dispatch-key-2",
      sanitizedRequest: { provider: "omnipack" },
    })).toMatchObject({
      id: "ref-2",
      provider_order_id: "provider-2",
      status: "uncertain",
      sanitized_request: { provider: "omnipack" },
    });
    expect(omnipackDispatchCandidateIds([
      "fulfillment-1",
      { fulfillment_order_id: "fulfillment-2" },
      { fulfillmentOrderId: "fulfillment-3" },
      null,
      { fulfillment_order_id: 4 },
    ])).toEqual(["fulfillment-1", "fulfillment-2", "fulfillment-3"]);
    expect(omnipackDispatchCandidateIds({ fulfillment_order_id: "not-an-array" })).toEqual([]);
    // `sequence_no` is not decoration on this list: without it the derivation below reads every
    // parcel as the original and sends one number twice, the exact failure it exists to prevent.
    for (const column of ["shipping_address_snapshot", "addresses(metadata)", "sequence_no"]) {
      expect(OMNIPACK_DISPATCH_CANDIDATE_SELECT).toContain(column);
    }
  });

  // The provider number is a pure function of two immutable columns. `-R{n}` is the provider's
  // uniqueness requirement and nothing else: the customer's number never carries it, which is what
  // `src/lib/orderRef.test.ts` pins from the other side.
  it("numbers a replacement parcel for the provider without touching the original", () => {
    // The order number comes from the fixture rather than being restated, so this stays true of
    // whatever shape our numbers take: the assertion is about the suffix, not about the prefix.
    const number = candidateRow().commerce_orders?.order_number ?? "";
    expect(providerOrderNumberFor(number, 0)).toBe(number);
    expect(providerOrderNumberFor(number, 1)).toBe(`${number}-R1`);
    expect(providerOrderNumberFor(number, 2)).toBe(`${number}-R2`);
    // A number the read never supplied stays absent; the payload builder falls back to the order id.
    expect(providerOrderNumberFor(null, 3)).toBeNull();
    // Defensive, not reachable through the DB default: a negative or absent ordinal is the original.
    expect(providerOrderNumberFor(number, -1)).toBe(number);

    const original = candidateRow();
    const replacement = { ...candidateRow(), id: "fulfillment-2", sequence_no: 1 };
    expect([original, replacement].map((row) => toOmnipackDispatchCandidate(row).orderNumber))
      .toEqual([number, `${number}-R1`]);
  });
});

function candidateRow(): OmnipackDispatchCandidateRow {
  return {
    id: "fulfillment-1",
    order_id: "order-1",
    status: "created",
    metadata: {},
    shipping_address_snapshot: {
      label: "Home",
      deliveryContact: deliveryContactFixture({
        recipientName: "Frozen Recipient",
        contactEmail: "frozen@example.test",
        contactPhone: "+48222222222",
        line1: "Frozen Street 1",
        city: "Warsaw",
        selectedDelivery: { providerKind: "other", serviceCode: "ORDER_SERVICE" },
      }).canonical,
      line1: "Frozen Street 1",
      city: "Warsaw",
      postalCode: "00-001",
      country: "PL",
      selectedDelivery: null,
    },
    commerce_orders: {
      order_number: "OPENLUP-1",
      metadata: { selectedDelivery: { providerKind: "other", serviceCode: "ORDER_SERVICE" } },
    },
    clients: {
      email: "customer@example.test",
      first_name: "Test",
      last_name: "Customer",
      phone: "+48111111111",
    },
    addresses: {
      metadata: {
        selectedDelivery: { providerKind: "other", serviceCode: "ADDRESS_SERVICE" },
      },
    },
    commerce_fulfillment_order_lines: [
      { sku: "SKU-VALID", title: "Valid", quantity: 2, product_snapshot: { lot: "LOT-1" } },
      { sku: "", title: "Missing SKU", quantity: 1, product_snapshot: {} },
      { sku: "SKU-ZERO", title: "Zero", quantity: 0, product_snapshot: {} },
    ],
  };
}
