import { createHash } from "node:crypto";
import { syncInvoicePayoutSettlements } from "@openlup/platform/invoicing";
import type { InvoiceSettlementPort, InvoiceUnsupported } from "@openlup/platform/invoicing/contracts";
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
// A closed mapped DTO also fits the existing cron's Record<string, unknown> envelope.
} | (Pick<InvoiceUnsupported, keyof InvoiceUnsupported> & { checked: 0; recorded: 0; replayed: 0; skipped: true });

export async function syncStripePayoutSettlements(input: {
  reader: StripePayoutSettlementReader;
  /** Legacy managed recorder preserves donor calls/counts; package receipts
   * separately expose its batch/payment granularity. */
  accountingPort?: AccountingControlPort;
  itemSettlement?: InvoiceSettlementPort;
  payoutLimit?: number;
}): Promise<StripePayoutSettlementSyncResult> {
  if (!input.itemSettlement && !input.accountingPort) return {
    kind: "unsupported", code: "host_binding_required", retryable: false, effectMayHaveSucceeded: false,
    checked: 0, recorded: 0, replayed: 0, skipped: true,
  };
  const providerRef = "stripe";
  const legacy = { recorded: 0, replayed: 0 };
  const accountingPort = input.accountingPort;
  const settlement: Pick<InvoiceSettlementPort, "record"> = input.itemSettlement ?? {
    record: async item => {
      const write = await accountingPort!.recordPaymentSettlement({
        idempotencyKey: item.requestKey, providerKind: providerRef,
        providerBatchId: item.batchRef, providerPaymentId: item.providerPaymentRef,
        paymentIntentId: null, paymentId: null, invoiceId: null,
        grossMinor: item.grossMinor, feeMinor: item.feeMinor, netMinor: item.netMinor,
        currency: item.currency, status: "matched", bankReceivedAt: item.bankReceivedAt,
        evidence: { providerReadbackSource: "provider_api", payoutId: item.batchRef,
          balanceTransactionId: item.itemRef, payoutStatus: "paid" },
      });
      if (write.replayed) legacy.replayed += 1;
      else legacy.recorded += 1;
      return { kind: "recorded", itemRef: item.itemRef, settlementItemRef: write.settlementItemId, replayed: write.replayed };
    },
  };
  const result = await syncInvoicePayoutSettlements({
    list: limit => input.reader.listRecentSettledPayoutItems(limit),
    limit: input.payoutLimit,
    project: item => ({
      requestKey: `stripe-settlement:${item.balanceTransactionId}`,
      providerRef, batchRef: item.payoutId, itemRef: item.balanceTransactionId,
      providerPaymentRef: item.providerPaymentId, paymentIntentRef: null, paymentRef: null, invoiceRef: null,
      grossMinor: item.grossMinor, feeMinor: item.feeMinor, netMinor: item.netMinor,
      currency: item.currency, status: "matched", bankReceivedAt: item.bankReceivedAt,
      proof: { evidenceRef: item.balanceTransactionId, fingerprint: `sha256:${createHash("sha256").update(JSON.stringify(item)).digest("hex")}`, observedAt: new Date().toISOString() },
    }),
    settlement,
  });
  // Preserve the donor facade's aggregate result, including legacy collapsed rows.
  return { checked: result.checked, ...(input.itemSettlement ? { recorded: result.recorded, replayed: result.replayed } : legacy) };
}
