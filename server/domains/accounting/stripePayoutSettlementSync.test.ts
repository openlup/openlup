import { describe, expect, it, vi } from "vitest";
import type { InvoiceSettlementItem, InvoiceSettlementPort } from "@openlup/platform/invoicing/contracts";
import { syncStripePayoutSettlements } from "./stripePayoutSettlementSync.js";

describe("Stripe payout settlement sync", () => {
  it("records distinct balance items for the same payout/payment through an item-capable host port with exact original keys and nullable links", async () => {
    const stored = new Map<string, string>();
    const record = vi.fn<InvoiceSettlementPort["record"]>(async item => {
      const previous = stored.get(item.itemRef);
      const settlementItemRef = previous ?? `host-item:${item.itemRef}`;
      stored.set(item.itemRef, settlementItemRef);
      return { kind: "recorded", itemRef: item.itemRef, settlementItemRef, replayed: previous !== undefined };
    });
    const result = await syncStripePayoutSettlements({
      reader: { listRecentSettledPayoutItems: vi.fn(async () => [settlement("txn-1", "pi-1"), settlement("txn-2", "pi-1"), settlement("txn-1", "pi-1")]) },
      itemSettlement: { record, resolve: async () => ({ kind: "unsupported", code: "unsupported", retryable: false, effectMayHaveSucceeded: false }) },
    });
    expect(result).toEqual({ checked: 3, recorded: 2, replayed: 1 });
    expect(stored.size).toBe(2);
    expect(record).toHaveBeenNthCalledWith(1, expect.objectContaining({
      requestKey: "stripe-settlement:txn-1", itemRef: "txn-1", providerRef: "stripe",
      batchRef: "po-1", providerPaymentRef: "pi-1", paymentIntentRef: null, paymentRef: null, invoiceRef: null,
      grossMinor: 10_000, feeMinor: 290, netMinor: 9_710, currency: "PLN", status: "matched", bankReceivedAt: "2026-07-16T10:00:00.000Z",
      proof: expect.objectContaining({ evidenceRef: "txn-1", fingerprint: expect.stringMatching(/^sha256:/) }),
    } satisfies Partial<InvoiceSettlementItem>));
    expect(record).toHaveBeenNthCalledWith(2, expect.objectContaining({ requestKey: "stripe-settlement:txn-2", itemRef: "txn-2", batchRef: "po-1", providerPaymentRef: "pi-1" }));
  });


  it("records normalized payout evidence through the existing idempotent port", async () => {
    const recordPaymentSettlement = vi.fn()
      .mockResolvedValueOnce({ settlementItemId: "item-1", replayed: false })
      .mockResolvedValueOnce({ settlementItemId: "item-2", replayed: true });

    const result = await syncStripePayoutSettlements({
      reader: {
        listRecentSettledPayoutItems: vi.fn(async () => [
          settlement("txn-1", "pi-1"),
          settlement("txn-2", "pi-2"),
        ]),
      },
      accountingPort: {
        requestInvoiceIssue: vi.fn(),
        recordProviderSyncEvent: vi.fn(),
        recordPaymentSettlement,
      },
    });

    expect(result).toEqual({ checked: 2, recorded: 1, replayed: 1 });
    expect(recordPaymentSettlement).toHaveBeenNthCalledWith(1, {
      idempotencyKey: "stripe-settlement:txn-1",
      providerKind: "stripe",
      providerBatchId: "po-1",
      providerPaymentId: "pi-1",
      paymentIntentId: null,
      paymentId: null,
      invoiceId: null,
      grossMinor: 10_000,
      feeMinor: 290,
      netMinor: 9_710,
      currency: "PLN",
      status: "matched",
      bankReceivedAt: "2026-07-16T10:00:00.000Z",
      evidence: {
        providerReadbackSource: "provider_api",
        payoutId: "po-1",
        balanceTransactionId: "txn-1",
        payoutStatus: "paid",
      },
    });
  });
  it("keeps donor counts and continues after the legacy recorder collapses distinct items", async () => {
    const recordPaymentSettlement = vi.fn()
      .mockResolvedValueOnce({ settlementItemId: "collapsed", replayed: false })
      .mockResolvedValueOnce({ settlementItemId: "collapsed", replayed: true })
      .mockResolvedValueOnce({ settlementItemId: "third", replayed: false });
    const listRecentSettledPayoutItems = vi.fn(async () => [settlement("txn-1", "pi-1"), settlement("txn-2", "pi-1"), settlement("txn-3", "pi-3")]);
    expect(await syncStripePayoutSettlements({ reader: { listRecentSettledPayoutItems }, accountingPort: {
      requestInvoiceIssue: vi.fn(), recordProviderSyncEvent: vi.fn(), recordPaymentSettlement,
    }, payoutLimit: 7 })).toEqual({ checked: 3, recorded: 2, replayed: 1 });
    expect(listRecentSettledPayoutItems).toHaveBeenCalledWith(7);
    expect(recordPaymentSettlement.mock.calls.map(([row]) => row.idempotencyKey)).toEqual(["stripe-settlement:txn-1", "stripe-settlement:txn-2", "stripe-settlement:txn-3"]);
    expect(recordPaymentSettlement).toHaveBeenCalledTimes(3);
  });

});

function settlement(balanceTransactionId: string, providerPaymentId: string) {
  return {
    payoutId: "po-1",
    balanceTransactionId,
    providerPaymentId,
    grossMinor: 10_000,
    feeMinor: 290,
    netMinor: 9_710,
    currency: "PLN",
    bankReceivedAt: "2026-07-16T10:00:00.000Z",
  };
}
