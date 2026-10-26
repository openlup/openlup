import { expect, it, vi } from "vitest";
import type { OrderRecapV3Response } from "@/domains/commerce/orderRecapContracts";
import { buildPurchasePayload } from "./purchaseAnalytics";

vi.mock("@/lib/analytics/dataLayer", () => ({ emitAnalyticsEvent: vi.fn(), isAnalyticsLoaderReady: () => false }));

function recap() {
  return {
    orderId: "order:synthetic", status: "paid", paymentStatus: "succeeded",
    checkoutKind: "one_time" as string | null, moneyReconciled: true,
    items: [{ sku: "ITEM-1" as string | null, variantCode: "standard" as string | null,
      quantity: 3, catalogTotalGross: 3003, effectiveNet: 2777, vatRateBps: 800 }],
    totals: { tax: { amountMinor: 230 }, total: { amountMinor: 3107, currency: "XTS" } },
  };
}

it("preserves the base reference purchase projection and ordered suppression transcript", () => {
  const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
  const cases: Array<[string, (value: ReturnType<typeof recap>) => void]> = [
    ["residual allocation and grouping", () => undefined],
    ["subscription and omitted variant", r => { r.checkoutKind = "subscription_initial"; r.items[0].variantCode = null; }],
    ["quantity cap accepted", r => { r.items[0].quantity = 200; }],
    ["quantity cap refused", r => { r.items[0].quantity = 201; }],
    ["grouped cap accepted", r => { r.items = Array.from({ length: 200 }, () => ({ ...r.items[0], quantity: 1 })); r.totals.total.amountMinor = 600000; }],
    ["grouped cap refused", r => { r.items = Array.from({ length: 67 }, () => ({ ...r.items[0] })); }],
    ["order_not_paid precedes payment", r => { r.status = "pending"; r.paymentStatus = "failed"; }],
    ["payment_not_succeeded precedes kind", r => { r.paymentStatus = "failed"; r.checkoutKind = null; }],
    ["checkout_kind_unsupported precedes reconciliation", r => { r.checkoutKind = null; r.moneyReconciled = false; }],
    ["renewal refused", r => { r.checkoutKind = "subscription_renewal"; }],
    ["money_unreconciled", r => { r.moneyReconciled = false; r.items = []; }],
    ["items_empty", r => { r.items = []; }],
    ["sku_missing", r => { r.items[0].sku = null; r.items[0].quantity = 0; }],
    ["quantity_invalid", r => { r.items[0].quantity = 0; r.items[0].catalogTotalGross = -1; }],
    ["line_money_invalid", r => { r.items[0].catalogTotalGross = -1; }],
    ["net_discount_invalid", r => { r.items[0].effectiveNet = 9999; }],
    ["shipping_net_invalid", r => { r.totals.total.amountMinor = 0; }],
    ["shipping residual", r => { r.totals.total.amountMinor = 3108; }],
  ];
  try {
    const transcript = cases.map(([name, mutate]) => {
      const value = recap(); mutate(value); warn.mockClear();
      const payload = buildPurchasePayload(value as unknown as OrderRecapV3Response);
      return { name, payload, diagnostics: warn.mock.calls.map(call => call[0]) };
    });
    expect(transcript).toMatchSnapshot();
  } finally { warn.mockRestore(); }
});
