import { createHash, createHmac } from "node:crypto";
import { expect, it, vi } from "vitest";
import { runPaymentAdapterConformance } from "../../../src/payments/index.js";
import { createStripePaymentAdapter, type StripePaymentAdapterConfig } from "../../../src/payments/stripe/index.js";
import type { VerifiedPaymentEvidence } from "../../../src/payments/contracts/index.js";

type Subject = Parameters<typeof runPaymentAdapterConformance>[0][number];
const timestamp = 1_800_000_000;
const occurredAt = new Date(timestamp * 1000).toISOString();
const signingKey = "conformance-fixture";

it("conforms across two distinct attempts with replay, changed outcomes, refunds and verification refusals", async () => {
  const fixtures = [
    { intentRef: "intent-a", attemptRef: "attempt-a", remote: "pi_a", amountMinor: 2599, currency: "EUR" },
    { intentRef: "intent-b", attemptRef: "attempt-b", remote: "pi_b", amountMinor: 7300, currency: "USD" },
  ];
  const intent = (fixture: typeof fixtures[number]) => ({ id: fixture.remote, status: "requires_action", amount: fixture.amountMinor,
    currency: fixture.currency.toLowerCase(), client_secret: `transient_${fixture.remote}` });
  const client: StripePaymentAdapterConfig["client"] = {
    createPaymentIntent: vi.fn(async input => {
      const fixture = fixtures.find(row => row.intentRef === input.metadata?.paymentIntentId);
      if (!fixture) throw new Error("unexpected execution subject");
      expect(input).toMatchObject({ amount: fixture.amountMinor, currency: fixture.currency.toLowerCase() });
      return intent(fixture);
    }),
    retrievePaymentIntent: vi.fn(async reference => {
      const fixture = fixtures.find(row => row.remote === reference);
      if (!fixture) throw new Error("unexpected readback subject");
      return intent(fixture);
    }),
  };
  const adapter = createStripePaymentAdapter({ client, mode: "test", supportedCurrencies: ["EUR", "USD"],
    webhookSigningSecrets: [signingKey], clock: () => timestamp });
  const subjects: Subject[] = fixtures.map(fixture => {
    const money = { amountMinor: fixture.amountMinor, currency: fixture.currency };
    const identity = { provider: "stripe", providerPaymentRef: fixture.remote, intentRef: fixture.intentRef, attemptRef: fixture.attemptRef };
    function verification(sourceType: string, outcome: VerifiedPaymentEvidence["outcome"], object: Record<string, unknown> = {}) {
      const eventId = `evt_${fixture.remote}_${outcome}`;
      const rawBody = Buffer.from(JSON.stringify({ id: eventId, type: sourceType, created: timestamp, data: { object: {
        id: fixture.remote, amount: money.amountMinor, currency: money.currency.toLowerCase(),
        metadata: { paymentIntentId: fixture.intentRef }, client_secret: `transient_${fixture.remote}`, ...object,
      } } }));
      const digest = createHmac("sha256", signingKey).update(`${timestamp}.`).update(rawBody).digest("hex");
      const input = { rawBody, headers: { "stripe-signature": `t=${timestamp},v1=${digest}` }, receivedAt: occurredAt };
      const normalized: Omit<VerifiedPaymentEvidence, "fingerprint" | "providerAuditPayload"> = {
        provider: "stripe", providerEventId: eventId, providerOccurredAt: occurredAt, kind: "money",
        providerPaymentRef: fixture.remote, intentRef: fixture.intentRef, attemptRef: null, outcome, money,
        ...(outcome === "refunded" ? { refund: { kind: "cumulative-snapshot", operationId: `ch_${fixture.remote}`,
          originalPaymentMoney: money, refundedMoney: { amountMinor: 500, currency: money.currency } } } : {}),
      };
      const expected: VerifiedPaymentEvidence = { ...normalized,
        fingerprint: createHash("sha256").update(JSON.stringify(normalized)).digest("hex"),
        providerAuditPayload: { provider: "stripe", eventId, eventType: sourceType, providerPaymentId: fixture.remote,
          amountMinor: money.amountMinor, currency: money.currency,
          ...(outcome === "refunded" ? { stripeRefundSnapshot: { chargeId: `ch_${fixture.remote}`, amountRefundedMinor: 500 } } : {}),
        },
      };
      return { input, expected };
    }
    const pending = verification("payment_intent.requires_action", "pending");
    const missingRefund = verification("charge.refunded", "refunded", { id: `ch_${fixture.remote}`, payment_intent: fixture.remote });
    return { subjectId: fixture.attemptRef, adapter,
      executionInput: { intentRef: fixture.intentRef, attemptRef: fixture.attemptRef,
        fingerprint: `fingerprint_${fixture.attemptRef}`, providerIdempotencyKey: `key_${fixture.attemptRef}`,
        money, mode: "test", purpose: "initial" },
      readbackInput: { identity, expectedMoney: money, purpose: "active_checkout" },
      verification: [pending, { ...pending, input: { ...pending.input, receivedAt: "2027-01-15T08:01:00.000Z" } },
        verification("payment_intent.succeeded", "succeeded"),
        verification("charge.dispute.created", "disputed", { id: `dp_${fixture.remote}`, payment_intent: fixture.remote }),
        verification("charge.refunded", "refunded", { id: `ch_${fixture.remote}`, payment_intent: fixture.remote, amount_refunded: 500 }),
        { input: { ...pending.input, headers: {} }, expected: { kind: "refusal", reason: "signature" } },
        { input: missingRefund.input, expected: { kind: "refusal", reason: "malformed" } },
      ],
    };
  });
  const evidence = await runPaymentAdapterConformance(subjects);
  expect(evidence.subjects.map(row => row.subjectId)).toEqual(["attempt-a", "attempt-b"]);
  expect(evidence.cases).toHaveLength(2);
  for (const [index, subject] of evidence.subjects.entries()) {
    expect(subject.execution).toMatchObject({ dispatch: { kind: "dispatched", providerPaymentRef: fixtures[index].remote } });
    expect(subject.readback).toMatchObject({ kind: "failed", identity: subjects[index].readbackInput.identity,
      observedMoney: subjects[index].readbackInput.expectedMoney });
    expect(subject.execution).not.toHaveProperty("handoff");
    expect(evidence.cases[index].passed).toBe(true);
    expect(JSON.stringify(evidence)).not.toContain(`transient_${fixtures[index].remote}`);
  }
  expect(client.createPaymentIntent).toHaveBeenCalledTimes(2);
  expect(client.retrievePaymentIntent).toHaveBeenCalledTimes(2);
});
