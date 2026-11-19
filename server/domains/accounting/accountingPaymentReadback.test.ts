import { describe, expect, it, vi } from "vitest";

import type { ClaimedAccountingInvoiceIssue } from "../../../src/domains/accounting/ports.js";
import { readAccountingPaymentProviderEvidence } from "./accountingPaymentReadback.js";

const claim = {
  payment: {
    provider: "stripe",
    providerPaymentId: "pi_1",
    amountCents: 2990,
  },
} as ClaimedAccountingInvoiceIssue;

describe("accounting provider payment readback", () => {
  it("returns exact fresh provider amount and currency without raw payload", async () => {
    const readPayment = vi.fn(async () => ({
      status: "succeeded" as const,
      providerStatus: "succeeded",
      occurredAt: null,
      failureReason: null,
      amountMinor: 2990,
      currency: "pln",
      rawPayload: { clientSecret: "must-not-cross" },
    }));
    await expect(readAccountingPaymentProviderEvidence(claim, { stripe: { readPayment } }))
      .resolves.toEqual({
        providerStatus: "succeeded",
        providerAmountCents: 2990,
        providerCurrency: "PLN",
        providerEvidence: {
          source: "provider_api",
          provider: "stripe",
          providerPaymentId: "pi_1",
          providerStatus: "succeeded",
          amountAvailable: true,
          currencyAvailable: true,
        },
      });
  });

  it.each([
    ["missing provider", {}, "provider_not_configured"],
    ["read error", { stripe: { readPayment: vi.fn(async () => { throw new Error("secret"); }) } }, "provider_read_failed"],
  ])("records %s as unavailable", async (_name, providers, reason) => {
    await expect(readAccountingPaymentProviderEvidence(claim, providers)).resolves.toMatchObject({
      providerStatus: "unavailable",
      providerAmountCents: null,
      providerCurrency: null,
      providerEvidence: { provider: "stripe", providerPaymentId: "pi_1", unavailableReason: reason },
    });
  });

  it.each([
    { configuredAmountMinor: 2990, expectedStatus: "succeeded", expectedReason: undefined },
    { configuredAmountMinor: 2991, expectedStatus: "unknown", expectedReason: "provider_configured_amount_mismatch" },
  ])("uses the claimed settlement amount to compare configured money ($configuredAmountMinor)", async ({
    configuredAmountMinor, expectedStatus, expectedReason,
  }) => {
    const readPayment = vi.fn(async () => ({
      status: "succeeded" as const, providerStatus: "succeeded", amountMinor: null, configuredAmountMinor, currency: "XTS",
    }));
    const result = await readAccountingPaymentProviderEvidence(claim, { [claim.payment.provider]: { readPayment } });
    expect(result).toMatchObject({
      providerStatus: expectedStatus,
      providerAmountCents: null,
      providerEvidence: { amountAvailable: false, configuredComparisonAmountCents: configuredAmountMinor },
    });
    expect(result.providerEvidence.unavailableReason).toBe(expectedReason);
  });

  it("keeps incomplete succeeded readback explicit instead of inventing agreement", async () => {
    await expect(readAccountingPaymentProviderEvidence(claim, {
      stripe: {
        readPayment: vi.fn(async () => ({
          status: "succeeded" as const,
          providerStatus: "succeeded",
          occurredAt: null,
          failureReason: null,
          amountMinor: null,
          currency: null,
          rawPayload: {},
        })),
      },
    })).resolves.toMatchObject({
      providerStatus: "succeeded",
      providerAmountCents: null,
      providerCurrency: null,
      providerEvidence: {
        providerPaymentId: "pi_1",
        amountAvailable: false,
        currencyAvailable: false,
      },
    });
  });
});
