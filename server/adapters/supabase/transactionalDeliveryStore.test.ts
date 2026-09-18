import { describe, expect, it, vi } from "vitest";

import {
  createReceiptFixtureScope,
  createManagedReceiptStoreScope,
  createManagedTransactionalDeliveryStore,
} from "./transactionalDeliveryStore.js";

const accepted = {
  idempotency_key: "delivery:1", command_fingerprint: "a".repeat(64), state: "accepted",
  delivery_reference: "captured:delivery:1", error_code: null, attempt_count: 2,
};
const managedEnv = {
  SUPABASE_URL: "https://managed.supabase.co",
  SUPABASE_SERVICE_ROLE_KEY: "service",
  MANAGED_DB_PROJECT_REF: "managed",
};

describe("managed transactional delivery receipt store", () => {
  it("uses only the three receipt RPCs and maps their neutral rows", async () => {
    const rpc = vi.fn()
      .mockResolvedValueOnce({ data: [], error: null })
      .mockResolvedValueOnce({ data: accepted, error: null })
      .mockResolvedValueOnce({ data: { ...accepted, state: "failed", delivery_reference: null, error_code: "captured_delivery_failed" }, error: null });
    const store = createManagedTransactionalDeliveryStore({ rpc });

    await expect(store.readReceipt("delivery:1")).resolves.toBeNull();
    await expect(store.recordAccepted({ idempotencyKey: "delivery:1", commandFingerprint: "a".repeat(64), deliveryReference: "captured:delivery:1" }))
      .resolves.toMatchObject({ state: "accepted", attemptCount: 2 });
    await expect(store.recordFailed({ idempotencyKey: "delivery:1", commandFingerprint: "a".repeat(64), errorCode: "captured_delivery_failed" }))
      .resolves.toMatchObject({ state: "failed", errorCode: "captured_delivery_failed" });
    expect(rpc.mock.calls).toEqual([
      ["transactional_delivery_read_receipt", { p_idempotency_key: "delivery:1" }],
      ["transactional_delivery_record_accepted", {
        p_idempotency_key: "delivery:1", p_command_fingerprint: "a".repeat(64), p_delivery_reference: "captured:delivery:1",
      }],
      ["transactional_delivery_record_failed", {
        p_idempotency_key: "delivery:1", p_command_fingerprint: "a".repeat(64), p_error_code: "captured_delivery_failed",
      }],
    ]);
  });

  it("fails closed for a receipt RPC error or malformed row", async () => {
    await expect(createManagedTransactionalDeliveryStore({
      rpc: async () => ({ data: null, error: { code: "22023", message: "bad" } }),
    }).readReceipt("delivery:1")).rejects.toMatchObject({ code: "22023" });
    await expect(createManagedTransactionalDeliveryStore({
      rpc: async () => ({ data: { state: "accepted" }, error: null }),
    }).readReceipt("delivery:1")).rejects.toThrow("transactional_delivery_receipt_invalid");
  });

  it("keeps managed service construction at the concrete receipt boundary", async () => {
    const rpc = vi.fn()
      .mockResolvedValueOnce({ data: [], error: null })
      .mockResolvedValueOnce({ data: accepted, error: null });
    let calls = 0;
    const scope = createManagedReceiptStoreScope(
      managedEnv,
      { gatewayFactory: () => ({ async asService<T>(work: (client: unknown) => Promise<T>): Promise<T> { calls += 1; return work({ rpc }); } }) },
    );

    await expect(scope?.run(async (store) => {
      await expect(store.readReceipt("delivery:1")).resolves.toBeNull();
      return store.recordAccepted({ idempotencyKey: "delivery:1", commandFingerprint: "a".repeat(64), deliveryReference: "captured:delivery:1" });
    })).resolves.toMatchObject({ state: "accepted" });
    expect(calls).toBe(1);
  });

  it("confines fixture cleanup to an exact attempt-bound parity key", async () => {
    const eq = vi.fn(async () => ({ data: [], error: null }));
    const from = vi.fn(() => ({
      delete: () => ({ eq }),
      select: () => ({ eq }),
    }));
    const scope = createReceiptFixtureScope(managedEnv, { fixtureClientFactory: () => ({ from }) });

    await expect(scope.cleanupReceipt("delivery:1")).rejects.toThrow("outside the parity namespace");
    expect(from).not.toHaveBeenCalled();
    const key = `delivery-parity:${"a".repeat(48)}`;
    await expect(scope.cleanupReceipt(key)).resolves.toBeUndefined();
    expect(eq).toHaveBeenNthCalledWith(1, "idempotency_key", key);
    expect(eq).toHaveBeenNthCalledWith(2, "idempotency_key", key);
  });
});
