import { createHash, createHmac } from "node:crypto";
import { expect, vi } from "vitest";
import { runPaymentAdapterConformance } from "../../../src/payments/testing/index.js";
import { createScriptedPaymentFake, type ScriptedPaymentOutcome } from "../../../src/payments/testing/index.js";
import { createStripePaymentAdapter, type StripePaymentAdapterConfig } from "../../../src/payments/stripe/index.js";
import type { VerifiedPaymentEvidence } from "../../../src/payments/contracts/index.js";

import type { PaymentAdapterSafetyScenarios, PaymentAdapterTestSubject } from "../../../src/payments/testing/index.js";

type Subject = Parameters<typeof runPaymentAdapterConformance>[0][number];
const timestamp = 1_800_000_000;
const occurredAt = new Date(timestamp * 1000).toISOString();
const signingKey = "conformance-fixture";

export function createStripeConformanceFixture() {
  const fixtures = [
    { intentRef: "intent-a", attemptRef: "attempt-a", remote: "pi_a", amountMinor: 2599, currency: "EUR" },
    { intentRef: "intent-b", attemptRef: "attempt-b", remote: "pi_b", amountMinor: 7300, currency: "USD" },
  ];
  const intent = (fixture: typeof fixtures[number]) => ({ id: fixture.remote, status: "requires_action", amount: fixture.amountMinor,
    currency: fixture.currency.toLowerCase(), client_secret: `transient_${fixture.remote}` });
  const fake = createScriptedPaymentFake<{ create: unknown; read: unknown }>();
  let failure: ScriptedPaymentOutcome<unknown> | undefined;
  const client: StripePaymentAdapterConfig["client"] = {
    createPaymentIntent: vi.fn(async input => {
      const fixture = fixtures.find(row => row.intentRef === input.metadata?.paymentIntentId);
      if (!fixture) throw new Error("unexpected execution subject");
      expect(input).toMatchObject({ amount: fixture.amountMinor, currency: fixture.currency.toLowerCase() });
      fake.enqueue("create", failure ?? { kind: "success", value: intent(fixture) });
      failure = undefined;
      return await fake.invoke("create") as ReturnType<typeof intent>;
    }),
    retrievePaymentIntent: vi.fn(async reference => {
      const fixture = fixtures.find(row => row.remote === reference);
      if (!fixture) throw new Error("unexpected readback subject");
      fake.enqueue("read", { kind: "success", value: intent(fixture) });
      return await fake.invoke("read") as ReturnType<typeof intent>;
    }),
  };
  const adapter = createStripePaymentAdapter({ client, mode: "test", supportedCurrencies: ["EUR", "USD"],
    webhookSigningSecrets: [signingKey], clock: () => timestamp });
  const subjects = fixtures.map(fixture => {
    const money = { amountMinor: fixture.amountMinor, currency: fixture.currency };
    const identity = { provider: "stripe", providerPaymentRef: fixture.remote, intentRef: fixture.intentRef, attemptRef: fixture.attemptRef };
    function verification(sourceType: string, outcome: VerifiedPaymentEvidence["outcome"], object: Record<string, unknown> = {}, signedAt = timestamp) {
      const amount = "amount" in object ? object.amount as number | undefined : money.amountMinor;
      const currency = "currency" in object ? object.currency as string | undefined : money.currency;
      const observedMoney = amount && currency ? { amountMinor: amount, currency: currency.toUpperCase() } : null;
      const eventId = `evt_${fixture.remote}_${outcome}`;
      const rawBody = Buffer.from(JSON.stringify({ id: eventId, type: sourceType, created: timestamp, data: { object: {
        id: fixture.remote, amount: money.amountMinor, currency: money.currency.toLowerCase(),
        metadata: { paymentIntentId: fixture.intentRef }, client_secret: `transient_${fixture.remote}`, ...object,
      } } }));
      const digest = createHmac("sha256", signingKey).update(`${signedAt}.`).update(rawBody).digest("hex");
      const input = { rawBody, headers: { "stripe-signature": `t=${signedAt},v1=${digest}` }, receivedAt: occurredAt };
      const normalized: Omit<VerifiedPaymentEvidence, "fingerprint" | "providerAuditPayload"> = {
        provider: "stripe", providerEventId: eventId, providerOccurredAt: occurredAt, kind: "money",
        providerPaymentRef: fixture.remote, intentRef: fixture.intentRef, attemptRef: null, outcome, money: observedMoney,
        ...(outcome === "refunded" ? { refund: { kind: "cumulative-snapshot", operationId: `ch_${fixture.remote}`,
          originalPaymentMoney: money, refundedMoney: { amountMinor: 500, currency: money.currency } } } : {}),
      };
      const expected: VerifiedPaymentEvidence = { ...normalized,
        fingerprint: createHash("sha256").update(JSON.stringify(normalized)).digest("hex"),
        providerAuditPayload: { provider: "stripe", eventId, eventType: sourceType, providerPaymentId: fixture.remote,
          amountMinor: amount ?? null, currency: currency?.toUpperCase() ?? null,
          ...(outcome === "refunded" ? { stripeRefundSnapshot: { chargeId: `ch_${fixture.remote}`, amountRefundedMinor: 500 } } : {}),
        },
      };
      return { input, expected };
    }
    const pending = verification("payment_intent.requires_action", "pending");
    const missingRefund = verification("charge.refunded", "refunded", { id: `ch_${fixture.remote}`, payment_intent: fixture.remote });
    return { verificationFixture: verification, subjectId: fixture.attemptRef, adapter,
      executionInput: { intentRef: fixture.intentRef, attemptRef: fixture.attemptRef,
        fingerprint: `fingerprint_${fixture.attemptRef}`, providerIdempotencyKey: `key_${fixture.attemptRef}`,
        money, mode: "test", purpose: "initial" },
      readbackInput: { identity, expectedMoney: money, purpose: "active_checkout" },
      verification: [pending, { ...pending, input: { ...pending.input, receivedAt: new Date((timestamp + 60) * 1000).toISOString() } },
        verification("payment_intent.succeeded", "succeeded"),
        ...[-300, 300].map(delta => verification("payment_intent.requires_action", "pending", {}, timestamp + delta)),
        ...[-301, 301].map(delta => ({ input: verification("payment_intent.requires_action", "pending", {}, timestamp + delta).input, expected: { kind: "refusal" as const, reason: "stale" as const } })),
        verification("charge.dispute.created", "disputed", { id: `dp_${fixture.remote}`, payment_intent: fixture.remote }),
        verification("charge.refunded", "refunded", { id: `ch_${fixture.remote}`, payment_intent: fixture.remote, amount_refunded: 500 }),
        { input: { ...pending.input, headers: {} }, expected: { kind: "refusal", reason: "signature" } },
        { input: missingRefund.input, expected: { kind: "refusal", reason: "malformed" } },
      ],
    } satisfies Subject & { verificationFixture: typeof verification };
  });
  return { subjects, client, fake, configureFailure: (step: ScriptedPaymentOutcome<unknown>) => { failure = step; } };
}

export function stripeSafetyFixture() {
  const fixture = createStripeConformanceFixture();
  const subjects: PaymentAdapterTestSubject[] = fixture.subjects.map(subject => {
    const input = subject.executionInput;
    const verification = subject.verificationFixture;
    const valid = verification("payment_intent.succeeded", "succeeded");
    const capabilityInputs = [
      ...fixture.subjects.flatMap(row => ["card", "wallet"].map(family => ({ ...row.executionInput,
        methodSelection: { family: family as "card" | "wallet" } }))),
      { ...input, purpose: "renewal-unattended" as const, storedMethod: { reference: "pm_fixture", mandate: {} } },
    ];
    const transport: PaymentAdapterSafetyScenarios["transport"] = {
      "timeout-before-dispatch": { calls: fixture.fake.calls, execute: () => fail("timeout-before-dispatch") },
      "provider-5xx-before-dispatch": { calls: fixture.fake.calls, execute: () => fail("provider-5xx") },
      "timeout-after-dispatch": { calls: fixture.fake.calls, execute: () => fail("timeout-after-dispatch") },
      "redelivery-409": { calls: fixture.fake.calls, execute: () => fail("redelivery-409") },
    };
    function fail(kind: "timeout-before-dispatch" | "provider-5xx" | "timeout-after-dispatch" | "redelivery-409") {
      fixture.configureFailure({ kind });
      return subject.adapter.attemptPort.execute(input);
    }
    return { ...subject, safety: { transport, capabilityInputs,
      unsupportedCurrencyInput: { ...input, money: { ...input.money, currency: "ZZZ" } },
      partialMoney: { amountMinor: 500, currency: input.money.currency }, webhooks: {
        valid, duplicate: { ...valid, input: { ...valid.input, receivedAt: new Date((timestamp + 60) * 1000).toISOString() } },
        signatureMismatch: { input: { ...valid.input, rawBody: Buffer.from("tampered") }, expected: { kind: "refusal", reason: "signature" } },
        partialAmount: verification("charge.refunded", "refunded", { id: `ch_${subject.readbackInput.identity.providerPaymentRef}`,
          payment_intent: subject.readbackInput.identity.providerPaymentRef, amount_refunded: 500 }),
        zeroAmount: verification("payment_intent.succeeded", "succeeded", { amount: 0 }),
        missingAmount: verification("payment_intent.succeeded", "succeeded", { amount: undefined }),
        missingCurrency: verification("payment_intent.succeeded", "succeeded", { currency: undefined }),
        chargeback: verification("charge.dispute.created", "disputed", { id: "dp_fixture", payment_intent: subject.readbackInput.identity.providerPaymentRef }),
      } } };
  });
  return { ...fixture, subjects };
}
