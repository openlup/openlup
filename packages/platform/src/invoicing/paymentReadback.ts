type PaymentEvidence = {
  providerStatus: "succeeded" | "failed" | "pending" | "unknown" | "unavailable";
  providerAmountCents: number | null;
  providerCurrency: string | null;
  providerEvidence: Record<string, unknown>;
};

export async function readInvoicePaymentEvidence(
  payment: { provider: string; providerPaymentId: string | null },
  provider: { readPayment(input: { providerPaymentId: string }): Promise<{
    status: "succeeded" | "failed" | "pending" | "unknown"; providerStatus: string; amountMinor: number | null; currency: string | null;
  }> } | undefined,
): Promise<PaymentEvidence> {
  const providerName = payment.provider;
  if (!provider || !payment.providerPaymentId) {
    return unavailable(
      providerName,
      payment.providerPaymentId,
      provider ? "provider_payment_id_missing" : "provider_not_configured",
    );
  }

  try {
    const readback = await provider.readPayment({
      providerPaymentId: payment.providerPaymentId,
    });
    return {
      providerStatus: readback.status,
      providerAmountCents: integerOrNull(readback.amountMinor),
      providerCurrency: currencyOrNull(readback.currency),
      providerEvidence: {
        source: "provider_api",
        provider: providerName,
        providerPaymentId: payment.providerPaymentId,
        providerStatus: readback.providerStatus.slice(0, 80),
        amountAvailable: integerOrNull(readback.amountMinor) !== null,
        currencyAvailable: currencyOrNull(readback.currency) !== null,
      },
    };
  } catch {
    return unavailable(providerName, payment.providerPaymentId, "provider_read_failed");
  }
}

function unavailable(
  provider: string,
  providerPaymentId: string | null,
  reason: string,
): PaymentEvidence {
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
