import { describe, expect, it, vi } from "vitest";
import { COMMERCE_CONTRACT_VERSION } from "../../../src/domains/commerce/types.js";
import { deliveryContactFixture } from "../../../src/domains/commerce/omsClient.fixtures.js";
import type { CommerceOmsConflictError } from "../../../src/domains/commerce/omsPorts.js";
import type { CommerceOmsSupabaseClient } from "./commerce/oms/types.js";
import { mapRpcError, updateCommerceOmsShippingAddress } from "./commerceOmsMutations.js";

const CONTACT_DIGEST = "0123456789abcdef0123456789abcdef";

describe("Supabase commerce OMS mutations", () => {
  it("uses the transactional shipping address RPC for address corrections", async () => {
    const client = {
      rpc: vi.fn().mockResolvedValue({ data: updateShippingAddressResponse(), error: null }),
      from: vi.fn(),
    } as unknown as CommerceOmsSupabaseClient;

    await expect(
      updateCommerceOmsShippingAddress(client, {
        idempotencyKey: "oms-address-1",
        orderId: "42222222-2222-4222-8222-222222222221",
        expectedRevision: 3,
        expectedContactDigest: CONTACT_DIGEST,
        actorUserId: "admin-user-1",
        address: {
          recipientName: "Ala Kowalska", contactEmail: "ala@example.com", contactPhone: "500600700",
          line1: "Prosta 1", city: "Warszawa", postalCode: "00-001", country: "PL",
        },
      }),
    ).resolves.toMatchObject({ operation: { type: "shipping_address_updated" } });

    expect(client.rpc).toHaveBeenCalledWith("commerce_oms_update_shipping_address", {
      p_idempotency_key: "oms-address-1",
      p_order_id: "42222222-2222-4222-8222-222222222221",
      p_actor_user_id: "admin-user-1",
      p_address: {
        recipientName: "Ala Kowalska", contactEmail: "ala@example.com", contactPhone: "500600700",
        line1: "Prosta 1", city: "Warszawa", postalCode: "00-001", country: "PL",
      },
      p_metadata: {
        _deliveryContactExpectedRevision: 3,
        _deliveryContactExpectedDigest: CONTACT_DIGEST,
      },
    });
    expect(client.from).not.toHaveBeenCalled();
  });

  it("maps RPC address locks to an operator-safe conflict", async () => {
    const client = {
      rpc: vi.fn().mockResolvedValue({
        data: null,
        error: {
          code: "22023",
          message: "commerce_oms_shipping_address_locked_after_label",
        },
      }),
      from: vi.fn(),
    } as unknown as CommerceOmsSupabaseClient;

    await expect(
      updateCommerceOmsShippingAddress(client, {
        idempotencyKey: "oms-address-1",
        orderId: "42222222-2222-4222-8222-222222222221",
        expectedRevision: 3,
        expectedContactDigest: CONTACT_DIGEST,
        actorUserId: "admin-user-1",
        address: {
          recipientName: "Ala Kowalska", contactEmail: "ala@example.com", contactPhone: "500600700",
          line1: "Prosta 1", city: "Warszawa", postalCode: "00-001", country: "PL",
        },
      }),
    ).rejects.toMatchObject({
      name: "CommerceOmsConflictError",
      details: { reason: "address_locked_after_label" },
    } satisfies Partial<CommerceOmsConflictError>);
  });

  it("overwrites a caller-supplied reserved revision key", async () => {
    const client = {
      rpc: vi.fn().mockResolvedValue({ data: updateShippingAddressResponse(), error: null }),
      from: vi.fn(),
    } as unknown as CommerceOmsSupabaseClient;

    await updateCommerceOmsShippingAddress(client, {
      idempotencyKey: "oms-address-2",
      orderId: "42222222-2222-4222-8222-222222222221",
      actorUserId: "admin-user-1",
      expectedRevision: 4,
      expectedContactDigest: CONTACT_DIGEST,
      address: deliveryContactFixture().address,
      metadata: {
        _deliveryContactExpectedRevision: 999,
        _deliveryContactExpectedDigest: "ffffffffffffffffffffffffffffffff",
        source: "test",
      },
    });

    expect(client.rpc).toHaveBeenCalledWith(
      "commerce_oms_update_shipping_address",
      expect.objectContaining({
        p_metadata: {
          source: "test",
          _deliveryContactExpectedRevision: 4,
          _deliveryContactExpectedDigest: CONTACT_DIGEST,
        },
      }),
    );
  });

  it.each([
    ["commerce_oms_delivery_contact_stale_revision", "delivery_contact_stale_revision"],
    ["commerce_oms_delivery_contact_submission_started", "delivery_contact_submission_started"],
  ])("maps %s to a stable operator refusal", async (message, reason) => {
    const client = {
      rpc: vi.fn().mockResolvedValue({ data: null, error: { code: "22023", message } }),
      from: vi.fn(),
    } as unknown as CommerceOmsSupabaseClient;

    await expect(updateCommerceOmsShippingAddress(client, {
      idempotencyKey: "oms-address-3",
      orderId: "42222222-2222-4222-8222-222222222221",
      actorUserId: "admin-user-1",
      expectedRevision: 4,
      expectedContactDigest: CONTACT_DIGEST,
      address: deliveryContactFixture().address,
    })).rejects.toMatchObject({ details: { reason } });
  });

  // The bounded lock wait the correction routine now sets surfaces as SQLSTATE
  // 55P03 with a server message that names nothing of ours, so the classification
  // has to read the code. It must land on the conflict class, because the request
  // wrote nothing and may be sent again unchanged - degrading it to a persistence
  // error would tell the operator to call someone instead of pressing the button.
  it("classifies a lock timeout by SQLSTATE, not by message text", async () => {
    const client = {
      rpc: vi.fn().mockResolvedValue({
        data: null,
        error: { code: "55P03", message: "canceling statement due to lock timeout" },
      }),
      from: vi.fn(),
    } as unknown as CommerceOmsSupabaseClient;

    await expect(updateCommerceOmsShippingAddress(client, {
      idempotencyKey: "oms-address-4",
      orderId: "42222222-2222-4222-8222-222222222221",
      actorUserId: "admin-user-1",
      expectedRevision: 4,
      expectedContactDigest: CONTACT_DIGEST,
      address: deliveryContactFixture().address,
    })).rejects.toMatchObject({
      name: "CommerceOmsConflictError",
      details: { code: "55P03", reason: "lock_timeout" },
    } satisfies Partial<CommerceOmsConflictError>);
  });

  // A lock timeout raised by any other routine this mapper serves gets the same
  // answer, and none of them borrows the shipping-address vocabulary.
  it("keeps the lock-timeout reason routine-neutral", () => {
    const mapped = mapRpcError({ code: "55P03", message: "canceling statement due to lock timeout" });
    expect((mapped as CommerceOmsConflictError).details).toEqual({ code: "55P03", reason: "lock_timeout" });
    expect(mapped.message).not.toContain("shipping address");
  });
});

function updateShippingAddressResponse() {
  const fixture = deliveryContactFixture({
    source: "oms_order_override", revision: 2, recipientName: "", contactPhone: "",
  });
  return {
    contractVersion: COMMERCE_CONTRACT_VERSION,
    result: "applied",
    scope: "order",
    deliveryContact: { ...fixture.canonical, recipientName: null, contactPhone: null },
    operation: {
      id: "b2222222-2222-4222-8222-222222222222",
      orderId: "42222222-2222-4222-8222-222222222221",
      type: "shipping_address_updated",
      holdId: null,
      actorUserId: "admin-user-1",
      occurredAt: "2026-06-05T10:05:00+00:00",
      payload: { source: "commerce.oms.v0" },
    },
    address: {
      recipientName: null, contactEmail: "ala@example.com", contactPhone: null, line1: "Prosta 1",
      line2: null, city: "Warszawa", postalCode: "00-001", country: "PL",
    },
    replayed: false,
  };
}
