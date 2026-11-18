import { expect, it, vi } from "vitest";
import { activateNativePurchaseWithRenewal, type NativeRenewalPurchaseFacts } from "../../src/subscriptions/nativePurchaseRenewal.js";

const facts: NativeRenewalPurchaseFacts = { settlementChannelKey: "sandbox", authorizationRef: "fixture", unattendedChargeAuthorizedAt: new Date(0).toISOString(),
  payerAccountRef: null, methodRef: "fixture", methodEvidenceRef: "fixture", stockSourceKey: "fixture", templateId: "fixture",
  cadenceDays: 28, currency: "XXX", lines: [], shippingAmountMinor: 0, acquisitionRef: null };
const purchase = { orderId: "fixture", idempotencyKey: "fixture-key", capturedReference: "fixture", facts };

it.each([0, 721, -1, 1.5, NaN, Infinity, "24", null])("refuses invalid edit window %s before any query", async value => {
  const query = vi.fn();
  await expect(activateNativePurchaseWithRenewal({ query }, { ...purchase, editWindowHours: value as number }))
    .rejects.toThrow("subscription_activation_edit_window_invalid");
  expect(query).not.toHaveBeenCalled();
});

it.each([undefined, 1, 24, 72, 720])("passes valid edit window %s only to activation", async editWindowHours => {
  const query = vi.fn(async (sql: string, _values?: unknown[]) => {
    if (sql.includes("subscription_register_renewal_purchase")) throw new Error("synthetic_registration_unavailable");
    return { rows: [{ response: {} }] };
  });
  await activateNativePurchaseWithRenewal({ query }, { ...purchase, editWindowHours });
  const calls = query.mock.calls;
  const activation = calls.find(([sql]) => sql.includes("subscription_activate_from_captured_payment"))!;
  expect(activation[0]).toBe(editWindowHours === undefined
    ? "SELECT public.subscription_activate_from_captured_payment($1::text,$2::uuid,$3::text) AS response"
    : "SELECT public.subscription_activate_from_captured_payment_with_edit_window($1::text,$2::uuid,$3::text,$4::integer) AS response");
  expect(activation[1]).toHaveLength(editWindowHours === undefined ? 3 : 4);
  if (editWindowHours !== undefined) expect(activation[1]?.[3]).toBe(editWindowHours);
});
