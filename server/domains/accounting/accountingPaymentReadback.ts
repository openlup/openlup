import { readInvoicePaymentEvidence } from "@openlup/platform/invoicing";
import type { ClaimedAccountingInvoiceIssue } from "../../../src/domains/accounting/ports.js";

export type AccountingPaymentProviderReadbackRegistry = Partial<
  Record<"stripe" | "tpay", {
    readPayment(input: { providerPaymentId: string }): Promise<{
      status: "succeeded" | "failed" | "pending" | "unknown";
      providerStatus: string;
      amountMinor: number | null;
      currency: string | null;
    }>;
  }>
>;

export type AccountingPaymentProviderEvidence = {
  providerStatus: "succeeded" | "failed" | "pending" | "unknown" | "unavailable";
  providerAmountCents: number | null;
  providerCurrency: string | null;
  providerEvidence: Record<string, unknown>;
};

export function readAccountingPaymentProviderEvidence(
  claim: ClaimedAccountingInvoiceIssue,
  providers: AccountingPaymentProviderReadbackRegistry,
): Promise<AccountingPaymentProviderEvidence> {
  const name = claim.payment.provider;
  return readInvoicePaymentEvidence(claim.payment, name === "stripe" || name === "tpay" ? providers[name] : undefined);
}
