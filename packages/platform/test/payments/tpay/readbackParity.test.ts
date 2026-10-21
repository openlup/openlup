import { beforeAll, expect, it, vi } from "vitest";
import { createTpayPaymentAdapter, type TpayPaymentAdapterConfig } from "../../../src/payments/tpay/index.js";
import { createTpayPaymentReconciliationProvider } from "../../../src/payments/tpay/tpayPaymentReconciliationProvider.js";
import type { ClaimedPaymentAttempt, ProviderReconciliationStatus } from "../../../src/payments/tpay/donorContracts.js";
import { createTpayJwsFixture } from "./webhookJws.testFixtures.js";

const identity = { provider: "tpay", providerPaymentRef: "api-1", intentRef: "intent-1", attemptRef: "attempt-1" };
const expectedMoney = { amountMinor: 2599, currency: "PLN" };
const attempt: ClaimedPaymentAttempt = {
  paymentAttemptId: identity.attemptRef, paymentIntentId: identity.intentRef, paymentId: "payment-1", orderId: "order-1",
  subscriptionId: null, subscriptionCycleId: null, provider: "tpay", providerPaymentId: identity.providerPaymentRef,
  providerAttemptId: null, providerSessionId: identity.providerPaymentRef, attemptStatus: "processing", intentStatus: "processing",
  ...expectedMoney, orderMode: "one_time", cycleRetryAttempt: 0, cycleNextRetryAt: null, localUpdatedAt: "2026-08-12T09:00:00.000Z",
};
const amounts = [
  { label: "equal", paidAmount: "25.99" },
  { label: "under", paidAmount: "20.00" },
  { label: "over", paidAmount: "30.00" },
  { label: "zero", paidAmount: "0.00" },
];
const statuses = [
  { label: "pending", values: ["pending"], kind: "pending", payments: {}, occurredAt: null },
  { label: "refused", values: ["pending"], kind: "failed",
    payments: { attempts: [{ date: "12.08.2026 12:00", paymentErrorCode: "51" }] }, occurredAt: "2026-08-12T10:00:00.000Z" },
  { label: "paid/correct", values: ["paid", "correct"], kind: "succeeded", payments: {}, occurredAt: null },
  { label: "chargeback", values: ["chargeback"], kind: "unknown", payments: {}, occurredAt: null },
  { label: "unknown", values: ["unrecognized"], kind: "unknown", payments: {}, occurredAt: null },
];
let certificates: ReturnType<typeof createTpayJwsFixture>;
beforeAll(() => { certificates = createTpayJwsFixture(7); });

// Five discovered cases exercise all 40 required combinations, plus both success aliases (48 observations).
it.each(statuses)("projects donor $label readback for both purposes and all paid amounts", async row => {
  let observations = 0;
  for (const status of row.values) {
    for (const purpose of ["active_checkout", "recovery"] as const) {
      for (const amount of amounts) {
        const label = `${status}/${row.label}/${purpose}/${amount.label}`;
        const transaction = { transactionId: identity.providerPaymentRef, status, amount: "25.99",
          paidAmount: amount.paidAmount, currency: "PLN", payments: row.payments };
        const donor = createTpayPaymentReconciliationProvider({ getTransaction: async () => transaction });
        const normalized = await donor.readPayment({ providerPaymentId: identity.providerPaymentRef, attempt, purpose });
        const recovery = await donor.readRecoveryPayment({ providerPaymentId: identity.providerPaymentRef, attempt, purpose });
        expect(normalized, label).toEqual(recovery.status);
        expect(normalized, label).toMatchObject({ status: row.kind, amountMinor: Math.round(Number(amount.paidAmount) * 100),
          occurredAt: row.occurredAt });
        expect(recovery, label).toMatchObject({ identityMatches: true, configuredMoneyMatches: true,
          manualReviewRequired: row.label === "chargeback" });

        // Pinned donor e0b142a77 host: paymentProviderReconciliationWorker.ts:215-225,
        // paymentVerifyNowService.ts:94-96 and checkoutRecoveryPaymentResolver.ts:135-136
        // gate both terminal statuses; zero paid refusals retain this adapter's unpaid-obligation rule.
        const manualReview = recovery.manualReviewRequired
          || ((normalized.status === "succeeded" || (normalized.status === "failed" && normalized.amountMinor !== 0))
            && terminalAmountMismatch(attempt, normalized) !== null);
        const base = { identity, expectedMoney, purpose };
        const expected = manualReview || !recovery.identityMatches || !recovery.configuredMoneyMatches || normalized.status === "unknown"
          ? { ...base, kind: "unknown", reason: "indeterminate" }
          : { ...base, kind: normalized.status, observedMoney: normalized.status === "succeeded"
            ? { amountMinor: normalized.amountMinor, currency: normalized.currency } : expectedMoney,
          providerOccurredAt: normalized.occurredAt };
        const fetchImpl = vi.fn<TpayPaymentAdapterConfig["http"]["fetchImpl"]>(async url => {
          expect(["https://api.example.test/oauth/auth", "https://api.example.test/transactions/api-1"]).toContain(url);
          return { ok: true, status: 200, text: async () => "", json: async () => url.endsWith("/oauth/auth")
            ? { access_token: "fixture", expires_in: 7200 } : transaction };
        });
        const adapter = createTpayPaymentAdapter({
          http: { baseUrl: "https://api.example.test", clientId: "synthetic-client", clientSecret: "synthetic-secret", fetchImpl },
          notification: { rootCertificatePem: certificates.rootCertificatePem,
            allowedCertificateUrlPrefix: "https://secure.sandbox.tpay.com/",
            resolveCertificate: async () => { throw new Error("readback must not resolve a certificate"); } },
          urls: { notificationUrl: "https://example.test/notify", successUrl: "https://example.test/ok", errorUrl: "https://example.test/error" },
          modelOActivationEnabled: true, mode: "test",
        });
        const actual = await adapter.readbackPort.readPayment(base);
        // Soft assertions retain every failing combination during historical discrimination runs.
        expect.soft(actual, label).toEqual(expected);
        expect.soft(actual.identity, label).toBe(identity);
        expect.soft(actual.expectedMoney, label).toBe(expectedMoney);
        if (row.label === "refused") {
          expect(actual.kind, label).toBe(amount.label === "under" || amount.label === "over" ? "unknown" : "failed");
        }
        expect(fetchImpl, label).toHaveBeenCalledTimes(2);
        observations += 1;
      }
    }
  }
  expect(observations).toBe(row.values.length * 8);
});

// Test-only host interpretation copied from pinned donor e0b142a's
// server/domains/payment/paymentProviderReconciliationEvidence.ts:33-44.
// Keep the witness package-local; the production adapter uses only the contributed provider.
function terminalAmountMismatch(
  attempt: ClaimedPaymentAttempt,
  status: ProviderReconciliationStatus,
): string | null {
  if (status.amountMinor !== null && status.amountMinor !== attempt.amountMinor) {
    return "provider_amount_mismatch";
  }
  if (status.currency && status.currency.toUpperCase() !== attempt.currency.toUpperCase()) {
    return "provider_currency_mismatch";
  }
  return null;
}
