import { describe, expect, it, vi } from "vitest";

import type { ClaimedAccountingInvoiceIssue } from "../../../src/domains/accounting/ports.js";
import { readAccountingPaymentProviderEvidence } from "./accountingPaymentReadback.js";

const claim = {
  payment: {
    provider: "stripe",
    providerPaymentId: "pi_1",
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
