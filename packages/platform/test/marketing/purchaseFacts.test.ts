import { expect, it, vi } from "vitest";
import { projectPaidPurchase, type PurchaseOrder } from "../../src/marketing/index.js";
function recap(): PurchaseOrder {
  return { orderId: "order:one", status: "paid", paymentStatus: "succeeded", checkoutKind: "one_time", moneyReconciled: true,
    items: [{ sku: "ITEM-1", variantCode: "standard", quantity: 3, catalogTotalGross: 3003, effectiveNet: 2777, vatRateBps: 800 }],
    totals: { tax: { amountMinor: 230 }, total: { amountMinor: 3107, currency: "XTS" } } };
}
it("projects paid money with deterministic residual allocation and grouping", () => {
  expect(projectPaidPurchase(recap())).toEqual({ transaction_id: "order:one", currency: "XTS", value: 27.77,
    shipping: 1, tax: 2.3, checkout_mode: "one_time", items: [
      { item_id: "ITEM-1", item_variant: "standard", price: 9.26, discount: 0.02, quantity: 1 },
      { item_id: "ITEM-1", item_variant: "standard", price: 9.26, discount: 0.01, quantity: 1 },
      { item_id: "ITEM-1", item_variant: "standard", price: 9.25, discount: 0.01, quantity: 1 },
    ] });
});
it("maps initial subscription and omits unavailable variants", () => {
  const value = recap(); value.checkoutKind = "subscription_initial"; value.items[0].variantCode = null;
  const result = projectPaidPurchase(value);
  expect(result?.checkout_mode).toBe("subscription");
  expect(result?.items).not.toContainEqual(expect.objectContaining({ item_variant: expect.anything() }));
});
it.each<[string, (value: PurchaseOrder) => void]>([
  ["order_not_paid", r => { r.status = "pending"; }],
  ["payment_not_succeeded", r => { r.paymentStatus = "failed"; }],
  ["checkout_kind_unsupported", r => { r.checkoutKind = null; }],
  ["money_unreconciled", r => { r.moneyReconciled = false; }],
  ["items_empty", r => { r.items = []; }],
  ["sku_missing", r => { r.items[0].sku = null; }],
  ["quantity_invalid", r => { r.items[0].quantity = 0; }],
  ["line_money_invalid", r => { r.items[0].catalogTotalGross = -1; }],
])("refuses %s", (reason, mutate) => {
  const value = recap(); mutate(value); const suppress = vi.fn(() => null);
  expect(projectPaidPurchase(value, suppress)).toBeNull(); expect(suppress).toHaveBeenCalledExactlyOnceWith(reason);
});
it("refuses expansion beyond the grouped item cap", () => {
  const value = recap(); value.items = Array.from({ length: 67 }, (_, i) => ({ ...value.items[0], sku: `ITEM-${i}` }));
  const suppress = vi.fn(() => null);
  expect(projectPaidPurchase(value, suppress)).toBeNull(); expect(suppress).toHaveBeenCalledExactlyOnceWith("item_limit_exceeded");
});
// New seam 6: the structural port preserves donor renewal support and remaining refusal boundaries.
it("projects structural renewal facts and preserves refusal order and cap edges", () => {
  const value = recap(); value.checkoutKind = "subscription_renewal";
  expect(projectPaidPurchase(value)?.checkout_mode).toBe("subscription");
  value.items[0].quantity = 200; expect(projectPaidPurchase(value)).not.toBeNull();
  const suppress = vi.fn(() => null); value.items[0].quantity = 201; value.items[0].effectiveNet = -1;
  expect(projectPaidPurchase(value, suppress)).toBeNull(); expect(suppress).toHaveBeenLastCalledWith("item_limit_exceeded");
  value.items[0].quantity = 1; value.items[0].effectiveNet = 9999;
  expect(projectPaidPurchase(value, suppress)).toBeNull(); expect(suppress).toHaveBeenLastCalledWith("net_discount_invalid");
  value.items[0].effectiveNet = 2777; value.totals.total.amountMinor = 0;
  expect(projectPaidPurchase(value, suppress)).toBeNull(); expect(suppress).toHaveBeenLastCalledWith("shipping_net_invalid");
});
