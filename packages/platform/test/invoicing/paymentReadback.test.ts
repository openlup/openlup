import { expect, it, vi } from "vitest";
import { readInvoicePaymentEvidence } from "../../src/invoicing/index.js";

it("reads only the final claimed payment identity and preserves mismatch, unknown and unavailable distinctions", async () => {
  const payment = { provider: "money-a", providerPaymentId: "final-claimed-id" };
  const provider = { readPayment: vi.fn(async () => ({ status: "succeeded" as "succeeded" | "unknown", providerStatus: "settled", amountMinor: 999 as number | null, currency: " xts " as string | null })) };
  expect(await readInvoicePaymentEvidence(payment, provider)).toEqual({ providerStatus: "succeeded", providerAmountCents: 999, providerCurrency: "XTS", providerEvidence: { source: "provider_api", provider: "money-a", providerPaymentId: "final-claimed-id", providerStatus: "settled", amountAvailable: true, currencyAvailable: true } });
  expect(provider.readPayment).toHaveBeenCalledWith({ providerPaymentId: "final-claimed-id" });
  provider.readPayment.mockResolvedValueOnce({ status: "unknown", providerStatus: "pending_lookup", amountMinor: null, currency: null });
  expect(await readInvoicePaymentEvidence(payment, provider)).toMatchObject({ providerStatus: "unknown", providerAmountCents: null, providerCurrency: null });
  provider.readPayment.mockResolvedValueOnce({ status: "succeeded", providerStatus: "settled", amountMinor: 1.2, currency: "invalid" });
  expect(await readInvoicePaymentEvidence(payment, provider)).toMatchObject({ providerStatus: "succeeded", providerAmountCents: null, providerCurrency: null });
  provider.readPayment.mockRejectedValueOnce(new Error("unavailable"));
  expect(await readInvoicePaymentEvidence(payment, provider)).toMatchObject({ providerStatus: "unavailable", providerEvidence: { unavailableReason: "provider_read_failed" } });
  expect(await readInvoicePaymentEvidence(payment, undefined)).toMatchObject({ providerStatus: "unavailable", providerEvidence: { unavailableReason: "provider_not_configured" } });
  provider.readPayment.mockClear();
  expect(await readInvoicePaymentEvidence({ ...payment, providerPaymentId: null }, provider)).toMatchObject({ providerStatus: "unavailable", providerEvidence: { unavailableReason: "provider_payment_id_missing" } });
  expect(provider.readPayment).not.toHaveBeenCalled();
});
