import { expect, it, vi } from "vitest";
import type { PaymentReadbackIdentityMismatch } from "@openlup/platform/payments/contracts";
import { readInvoicePaymentEvidence } from "../../src/invoicing/index.js";

it("reads the supplied payment identity and preserves normalized, unknown and unavailable evidence", async () => {
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

it.each([
  { observed: null, configured: 900, expectedStatus: "succeeded", expectedReason: undefined },
  { observed: null, configured: 700, expectedStatus: "unknown", expectedReason: "provider_configured_amount_mismatch" },
  { observed: null, configured: undefined, expectedStatus: "succeeded", expectedReason: undefined },
  { observed: 0, configured: 900, expectedStatus: "succeeded", expectedReason: undefined },
  { observed: 800, configured: 900, expectedStatus: "succeeded", expectedReason: undefined },
])("keeps payment observations ($observed) distinct from configured money ($configured)", async ({
  observed, configured, expectedStatus, expectedReason,
}) => {
  const payment = { provider: "money-a", providerPaymentId: "final-claimed-id", amountCents: 900 };
  const readPayment = vi.fn(async () => ({
    status: "succeeded" as const, providerStatus: "settled", amountMinor: observed, configuredAmountMinor: configured, currency: "XTS",
  }));
  const result = await readInvoicePaymentEvidence(payment, { readPayment });
  expect(result).toMatchObject({
    providerStatus: expectedStatus,
    providerAmountCents: observed,
    providerEvidence: { amountAvailable: observed !== null, providerStatus: "settled" },
  });
  expect(result.providerEvidence.unavailableReason).toBe(expectedReason);
  expect(result.providerEvidence.configuredComparisonAmountCents).toBe(observed === null ? configured : undefined);
});

it.each([
  { name: "a custom identity refusal", error: { code: "provider_payment_identity_mismatch" } satisfies PaymentReadbackIdentityMismatch,
    status: "unknown", reason: "provider_payment_identity_mismatch" },
  { name: "an ordinary error with the same message", error: new Error("provider_payment_identity_mismatch"),
    status: "unavailable", reason: "provider_read_failed" },
  { name: "an error with an unreadable code", error: { get code() { throw new Error("unreadable"); } },
    status: "unavailable", reason: "provider_read_failed" },
])("classifies $name by its code", async ({ error, status, reason }) => {
  const payment = { provider: "money-a", providerPaymentId: "final-claimed-id" };
  await expect(readInvoicePaymentEvidence(payment, { readPayment: async () => { throw error; } })).resolves.toMatchObject({
    providerStatus: status, providerEvidence: { unavailableReason: reason },
  });
});
