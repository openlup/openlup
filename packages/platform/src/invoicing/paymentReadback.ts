type PaymentEvidence = {
  providerStatus: "succeeded" | "failed" | "pending" | "unknown" | "unavailable";
  providerAmountCents: number | null;
  providerCurrency: string | null;
  providerEvidence: Record<string, unknown>;
};

export async function readInvoicePaymentEvidence(
  payment: {
    provider: string;
    providerPaymentId: string | null;
    /** Canonical claim amount for comparison when the captured amount is unavailable. */
    amountCents?: number;
  },
  provider: { readPayment(input: { providerPaymentId: string }): Promise<{
    status: "succeeded" | "failed" | "pending" | "unknown"; providerStatus: string; amountMinor: number | null; currency: string | null;
    configuredAmountMinor?: number;
    failureReason?: string | null;
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
    const capturedAmount = integerOrNull(readback.amountMinor);
    const configuredAmount = readback.status === "succeeded" && capturedAmount === null
      ? integerOrNull(readback.configuredAmountMinor ?? null) : null;
    const expectedAmount = integerOrNull(payment.amountCents ?? null);
    const configuredMismatch = configuredAmount !== null && expectedAmount !== null && configuredAmount !== expectedAmount;
    const unavailableReason = readback.status === "succeeded" && readback.failureReason === "provider_amount_mismatch"
      ? readback.failureReason
      : configuredMismatch ? "provider_configured_amount_mismatch" : null;
    return {
      providerStatus: unavailableReason ? "unknown" : readback.status,
      providerAmountCents: capturedAmount,
      providerCurrency: currencyOrNull(readback.currency),
      providerEvidence: {
        source: "provider_api",
        provider: providerName,
        providerPaymentId: payment.providerPaymentId,
        providerStatus: readback.providerStatus.slice(0, 80),
        amountAvailable: capturedAmount !== null,
        ...(configuredAmount !== null ? { configuredComparisonAmountCents: configuredAmount } : {}),
        ...(unavailableReason ? { unavailableReason } : {}),
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
