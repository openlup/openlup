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

export async function readAccountingPaymentProviderEvidence(
  claim: ClaimedAccountingInvoiceIssue,
  providers: AccountingPaymentProviderReadbackRegistry,
): Promise<AccountingPaymentProviderEvidence> {
  const providerName = claim.payment.provider;
  const provider = providerName === "stripe" || providerName === "tpay"
    ? providers[providerName]
    : undefined;
  if (!provider || !claim.payment.providerPaymentId) {
    return unavailable(
      providerName,
      claim.payment.providerPaymentId,
      provider ? "provider_payment_id_missing" : "provider_not_configured",
    );
  }

  try {
    const readback = await provider.readPayment({
      providerPaymentId: claim.payment.providerPaymentId,
    });
    return {
      providerStatus: readback.status,
      providerAmountCents: integerOrNull(readback.amountMinor),
      providerCurrency: currencyOrNull(readback.currency),
      providerEvidence: {
        source: "provider_api",
        provider: providerName,
        providerPaymentId: claim.payment.providerPaymentId,
        providerStatus: readback.providerStatus.slice(0, 80),
        amountAvailable: integerOrNull(readback.amountMinor) !== null,
        currencyAvailable: currencyOrNull(readback.currency) !== null,
      },
    };
  } catch {
    return unavailable(providerName, claim.payment.providerPaymentId, "provider_read_failed");
  }
}

function unavailable(
  provider: string,
  providerPaymentId: string | null,
  reason: string,
): AccountingPaymentProviderEvidence {
  return {
    providerStatus: "unavailable",
    providerAmountCents: null,
    providerCurrency: null,
    providerEvidence: {
      source: "provider_api",
      provider,
      providerPaymentId,
      unavailableReason: reason,
    },
  };
}

function integerOrNull(value: number | null): number | null {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : null;
}

function currencyOrNull(value: string | null): string | null {
  const normalized = value?.trim().toUpperCase() ?? "";
  return /^[A-Z]{3}$/.test(normalized) ? normalized : null;
}
