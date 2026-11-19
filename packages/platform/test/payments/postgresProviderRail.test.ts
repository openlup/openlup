import { describe, expect, it } from "vitest";
import { createPostgresProviderPaymentRail } from "../../src/payments/postgresProviderRail.js";
import type { PaymentAdapter, TransientSecret } from "../../src/payments/contracts/index.js";

const INTENT_ID = "11111111-1111-4111-8111-111111111111";
const ATTEMPT_ID = "22222222-2222-4222-8222-222222222222";
const TRANSIENT_HANDOFF = "fixture-transient-handoff-value" as TransientSecret;

function createRecordingExecutor() {
  const calls: Array<{ text: string; values: unknown[] }> = [];
  const executor = {
    async query(text: string, values: unknown[] = []) {
      calls.push({ text, values });
      if (text.includes("payment_provider_attempt_prepare")) {
        return {
          rows: [{
            response: {
              paymentAttempt: {
                id: ATTEMPT_ID,
                status: "created",
                replayed: false,
                providerAttemptId: null,
                providerSessionId: null,
                nextActionKind: null,
              },
            },
          }],
        };
      }
      if (text.includes("payment_provider_attempt_finalize")) {
        return {
          rows: [{
            response: {
              paymentAttempt: {
                id: ATTEMPT_ID,
                status: values[7],
                replayed: false,
                providerAttemptId: values[5],
                providerSessionId: values[6],
                nextActionKind: values[8],
              },
            },
          }],
        };
      }
      throw new Error(`unexpected query: ${text}`);
    },
  };
  return { executor, calls };
}

function buildCustomAdapter(handoff: { kind: "redirect"; url: string } | { kind: "client-confirmed"; payload: TransientSecret }): PaymentAdapter {
  return {
    capabilities: {
      providerKind: "custom_psp",
      captureFlows: [],
      requiresStoredMandateEvidence: false,
      assessMandate: () => ({ chargeable: true }),
      unattendedChargeFlow: "off_session_payment",
      payerContext: { requiresPayerBlock: false, customerRefFallsBackToContactEmail: false },
      methodHealth: { requiresCustomerRef: false, requiredMethodKind: null, requiresPayerContact: false },
      terminalOutcomeReporting: { kind: "status_field", silenceBecomesSuspectAfterMinutes: 60 },
      mandateUpsertIsSubscriptionScoped: false,
      supportedCurrencies: ["EUR"],
      unattended: "unsupported",
      readback: "unsupported",
      close: "unsupported",
      exactAbsence: "unsupported",
      refundObservation: "unsupported",
      refundCreate: "unsupported",
      authorizationCaptureSplit: "unsupported",
    },
    attemptPort: {
      validateInput: () => {},
      execute: async () => ({
        outcome: { kind: "attempt", status: "requires_action" },
        dispatch: { kind: "dispatched", providerPaymentRef: "remote-77" },
        handoff,
        diagnostics: { webhookExpected: true, recoveryRequired: false },
      }),
    },
    verifyPort: { verifyAndNormalize: async () => ({ kind: "refusal", reason: "unsupported-event" }) },
    readbackPort: { readPayment: async (req) => ({ kind: "unsupported", identity: req.identity, expectedMoney: req.expectedMoney, purpose: req.purpose }) },
  };
}

describe("createPostgresProviderPaymentRail persistence fallback", () => {
  it("synthesizes redacted fallback persistence when an adapter omits optional persistence", async () => {
    for (const handoff of [
      { kind: "redirect" as const, url: "https://provider.example.test/checkout/redirect-token" },
      { kind: "client-confirmed" as const, payload: TRANSIENT_HANDOFF },
    ]) {
      const { executor, calls } = createRecordingExecutor();
      const rail = createPostgresProviderPaymentRail({
        executor,
        adapter: buildCustomAdapter(handoff),
        mode: "test",
        truth: {
          contractVersion: "payment.truth.v1",
          provider: "custom_psp",
          providerReference: "test-ref",
          environment: "test",
        },
        resolveMethodOwner: async () => null,
        resolveSavedMethodOwner: async () => null,
      });

      const { attempt } = await rail.execute({
        attemptRef: "attempt-custom-1",
        intentRef: INTENT_ID,
        fingerprint: "fp-custom",
        providerIdempotencyKey: "key-custom",
        money: { amountMinor: 1000, currency: "EUR" },
        mode: "test",
        purpose: "initial",
      });

      expect(attempt).toMatchObject({
        providerAttemptId: "remote-77",
        providerSessionId: "remote-77",
        status: "requires_action",
        nextActionKind: handoff.kind === "redirect" ? "redirect" : "sca_required",
      });
      expect(calls).toHaveLength(2);
      const serialized = JSON.stringify(calls.map((c) => c.values));
      expect(serialized).not.toContain(TRANSIENT_HANDOFF);
      expect(serialized).not.toContain("https://provider.example.test/checkout/redirect-token");
    }
  });
});
