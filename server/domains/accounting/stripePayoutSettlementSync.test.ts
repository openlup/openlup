import { describe, expect, it, vi } from "vitest";
import { syncStripePayoutSettlements } from "./stripePayoutSettlementSync.js";

describe("Stripe payout settlement sync", () => {
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
