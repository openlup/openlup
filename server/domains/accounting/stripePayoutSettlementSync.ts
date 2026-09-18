import type { AccountingControlPort } from "../../../src/domains/accounting/ports.js";

export type StripePayoutSettlementItem = {
  payoutId: string;
  balanceTransactionId: string;
  providerPaymentId: string;
  grossMinor: number;
  feeMinor: number;
  netMinor: number;
  currency: string;
  bankReceivedAt: string;
};

export interface StripePayoutSettlementReader {
  listRecentSettledPayoutItems(limit: number): Promise<StripePayoutSettlementItem[]>;
}

export type StripePayoutSettlementSyncResult = {
  checked: number;
  recorded: number;
  replayed: number;
};

export async function syncStripePayoutSettlements(input: {
  reader: StripePayoutSettlementReader;
  accountingPort: AccountingControlPort;
  payoutLimit?: number;
}): Promise<StripePayoutSettlementSyncResult> {
  const items = await input.reader.listRecentSettledPayoutItems(input.payoutLimit ?? 10);
  const result = { checked: items.length, recorded: 0, replayed: 0 };

  for (const item of items) {
    const write = await input.accountingPort.recordPaymentSettlement({
      idempotencyKey: `stripe-settlement:${item.balanceTransactionId}`,
      providerKind: "stripe",
      providerBatchId: item.payoutId,
      providerPaymentId: item.providerPaymentId,
      paymentIntentId: null,
      paymentId: null,
      invoiceId: null,
      grossMinor: item.grossMinor,
      feeMinor: item.feeMinor,
      netMinor: item.netMinor,
      currency: item.currency,
      status: "matched",
      bankReceivedAt: item.bankReceivedAt,
      evidence: {
        providerReadbackSource: "provider_api",
        payoutId: item.payoutId,
        balanceTransactionId: item.balanceTransactionId,
        payoutStatus: "paid",
      },
    });
    if (write.replayed) result.replayed += 1;
    else result.recorded += 1;
  }

  return result;
}
