import { createHash, X509Certificate } from "node:crypto";
import { expect, vi } from "vitest";
import { runPaymentAdapterConformance } from "../../../src/payments/testing/index.js";
import { createScriptedPaymentFake, type ScriptedPaymentOutcome } from "../../../src/payments/testing/index.js";
import { createTpayPaymentAdapter, type TpayPaymentAdapterConfig } from "../../../src/payments/tpay/index.js";
import type { PaymentAttemptPort, TransientSecret, VerifiedPaymentEvidence } from "../../../src/payments/contracts/index.js";
import { createTpayJwsFixture } from "./webhookJws.testFixtures.js";

import type { PaymentAdapterSafetyScenarios, PaymentAdapterTestSubject } from "../../../src/payments/testing/index.js";

type Subject = Parameters<typeof runPaymentAdapterConformance>[0][number];
type AttemptInput = Parameters<PaymentAttemptPort["execute"]>[0];

export function createTpayConformanceFixture() {
  const certificate = createTpayJwsFixture(7);
  const timestamp = Date.parse(new X509Certificate(certificate.signingCertificatePem).validFrom) / 1000 + 10;
  const occurredAt = new Date(timestamp * 1000).toISOString();
  const fixtures = [
    { intentRef: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", attemptRef: "attempt-a", remote: "api-a", title: "TR-A", amountMinor: 2599 },
    { intentRef: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb", attemptRef: "attempt-b", remote: "api-b", title: "TR-B", amountMinor: 7300 },
  ];
  const unattendedRequests: unknown[] = [];
  const fake = createScriptedPaymentFake<{ http: unknown }>();
  let failure: { call: string; step: ScriptedPaymentOutcome<unknown> } | undefined;
  const fetch: TpayPaymentAdapterConfig["http"]["fetchImpl"] = vi.fn(async (url, init) => {
    let data: unknown;
    if (url.endsWith("/oauth/auth")) data = { access_token: "synthetic-token", expires_in: 7200 };
    else if (url.endsWith("/transactions") && init?.method === "POST") {
      const request = JSON.parse(init.body!);
      const fixture = fixtures.find(row => row.intentRef === request.hiddenDescription);
      if (!fixture) throw new Error("unexpected execution subject");
      expect(request).toMatchObject({ amount: fixture.amountMinor / 100, currency: "PLN" });
      if (request.pay?.blikPaymentData?.aliases) {
        unattendedRequests.push(request);
        expect(adapter.capabilities.unattendedChargeFlow).toBe("recurring_charge");
        expect(request.pay.blikPaymentData.type).toBe(2);
        expect(request.pay.blikPaymentData.aliases).toMatchObject({ value: "alias-fixture", type: "PAYID",
          noDelay: true, recommendedAuthLevel: "NOCONFREQ" });
      }
      data = { transactionId: fixture.remote, title: fixture.title, status: "pending",
        transactionPaymentUrl: `https://example.test/pay/${fixture.remote}`, payments: { errors: [] } };
    } else if (url.endsWith("/payments")) data = { payments: { attempts: [] } };
    else {
      const fixture = fixtures.find(row => url.endsWith(`/transactions/${row.remote}`));
      if (!fixture) throw new Error("unexpected readback subject");
      data = { transactionId: fixture.remote, title: fixture.title, status: "correct",
        amount: fixture.amountMinor / 100, paidAmount: fixture.amountMinor / 100, currency: "PLN" };
    }
    const call = url.endsWith("/oauth/auth") ? "oauth" : "transaction";
    fake.enqueue("http", failure?.call === call ? failure.step : { kind: "success", value: { ok: true, status: 200, json: async () => data, text: async () => "" } });
    if (failure?.call === call) failure = undefined;
    return await fake.invoke("http") as Awaited<ReturnType<TpayPaymentAdapterConfig["http"]["fetchImpl"]>>;
  });
  const config: TpayPaymentAdapterConfig = { http: { baseUrl: "https://api.example.test", clientId: "synthetic-client",
    clientSecret: "synthetic-secret", fetchImpl: fetch }, notification: { rootCertificatePem: certificate.rootCertificatePem,
    allowedCertificateUrlPrefix: "https://secure.sandbox.tpay.com/", resolveCertificate: async () => certificate.signingCertificatePem },
  urls: { notificationUrl: "https://example.test/notify", successUrl: "https://example.test/ok", errorUrl: "https://example.test/error" },
  modelOActivationEnabled: true, mode: "test", clock: () => timestamp };
  const adapter = createTpayPaymentAdapter(config);
  const subjects = fixtures.map((fixture, index) => {
    const money = { amountMinor: fixture.amountMinor, currency: "PLN" };
    const identity = { provider: "tpay", providerPaymentRef: fixture.remote, intentRef: fixture.intentRef, attemptRef: fixture.attemptRef };
    function verification(status: string, outcome: VerifiedPaymentEvidence["outcome"], patch: Record<string, unknown> = {}) {
      const amount = (money.amountMinor / 100).toFixed(2);
      const payload = { tr_id: fixture.title, tr_status: status, tr_amount: amount, tr_paid: amount,
        tr_currency: money.currency, tr_crc: fixture.intentRef, payer: `transient-${fixture.remote}@example.test`,
        customerAuthorization: "572913", handoff: `transient-handoff-${fixture.remote}`, ...patch };
      const rawBody = JSON.stringify(payload);
      const paid = ("tr_paid" in patch ? patch.tr_paid : amount) as string | undefined;
      const original = ("tr_amount" in patch ? patch.tr_amount : amount) as string | undefined;
      const reportedCurrency = ("tr_currency" in patch ? patch.tr_currency : money.currency) as string | undefined;
      const minor = Math.round(Number(paid || original) * 100);
      const observedMoney = Number.isSafeInteger(minor) && minor > 0 ? { amountMinor: minor, currency: reportedCurrency ?? "PLN" } : null;
      const input = { rawBody: Buffer.from(rawBody), headers: { "x-jws-signature": certificate.signature(rawBody, undefined, timestamp) }, receivedAt: occurredAt };
      const normalized: Omit<VerifiedPaymentEvidence, "fingerprint" | "providerAuditPayload"> = {
        provider: "tpay", providerOccurredAt: occurredAt, kind: "money", providerEventId: `${fixture.title}:${outcome}`,
        providerPaymentRef: fixture.title, intentRef: fixture.intentRef, attemptRef: null, outcome, money: observedMoney,
        ...(outcome === "refunded" ? { refund: { kind: "full-reversal", reason: "chargeback",
          operationId: `${fixture.title}:chargeback`, originalPaymentMoney: money } } : {}),
      };
      const expected: VerifiedPaymentEvidence = { ...normalized,
        fingerprint: createHash("sha256").update(JSON.stringify(normalized)).digest("hex"),
        providerAuditPayload: { provider: "tpay", eventKind: "transaction", transactionTitle: fixture.title,
          hiddenDescription: fixture.intentRef, transactionAmount: original ?? null, paidAmount: paid ?? null, currency: reportedCurrency ?? null, status, testMode: null },
      };
      return { input, expected };
    }
    const success = verification("TRUE", "succeeded");
    const chargeback = verification("CHARGEBACK", "refunded");
    const missingMoney = JSON.stringify({ tr_id: fixture.title, tr_status: "CHARGEBACK", tr_amount: "invalid", tr_paid: "25.99", tr_currency: "PLN" });
    const executionInput: AttemptInput = { intentRef: fixture.intentRef, attemptRef: fixture.attemptRef,
      fingerprint: `fingerprint-${fixture.attemptRef}`, providerIdempotencyKey: `key-${fixture.attemptRef}`,
      money, mode: "test", purpose: "initial", payer: { email: `transient-${fixture.remote}@example.test`, name: `Transient Person ${fixture.remote}` },
      methodSelection: index === 0 ? { family: "bank-redirect", channelRef: "42" } : { family: "one-time-code" },
      ...(index === 1 ? { customerAuthorization: "572913" as TransientSecret } : {}),
    };
    return { verificationFixture: verification, certificate, timestamp, subjectId: fixture.attemptRef, adapter, executionInput,
      readbackInput: { identity, expectedMoney: money, purpose: "active_checkout" },
      verification: [success, { ...success, input: { ...success.input, receivedAt: new Date((timestamp + 60) * 1000).toISOString() } },
        verification("FALSE", "failed"), chargeback,
        { input: { ...success.input, headers: {} }, expected: { kind: "refusal", reason: "signature" } },
        { input: { ...success.input, rawBody: Buffer.from(missingMoney), headers: { "x-jws-signature": certificate.signature(missingMoney, undefined, timestamp) } },
          expected: { kind: "refusal", reason: "malformed" } },
        { input: { ...success.input, receivedAt: new Date((timestamp + 7 * 24 * 60 * 60 + 1) * 1000).toISOString() }, expected: { kind: "refusal", reason: "stale" } },
      ],
    } satisfies Subject & { verificationFixture: typeof verification; certificate: typeof certificate; timestamp: number };
  });
  return { subjects, fake, config, unattendedRequests, configureFailure: (call: string, step: ScriptedPaymentOutcome<unknown>) => { failure = { call, step }; } };
}

export function tpaySafetyFixture() {
  const fixture = createTpayConformanceFixture();
  const subjects: PaymentAdapterTestSubject[] = fixture.subjects.map(subject => {
    const input = subject.executionInput;
    const verification = subject.verificationFixture;
    const valid = verification("TRUE", "succeeded");
    const { customerAuthorization: _authorization, ...withoutAuthorization } = input;
    const capabilityInputs = [
      { ...withoutAuthorization, methodSelection: { family: "bank-redirect" as const, channelRef: "42" } },
      { ...input, methodSelection: { family: "one-time-code" as const }, customerAuthorization: "572913" as NonNullable<typeof input.customerAuthorization> },
      { ...withoutAuthorization, purpose: "renewal-unattended" as const, methodSelection: undefined,
        storedMethod: { reference: "alias-fixture", mandate: { recurringModel: "O" } } },
    ];
    const transport: PaymentAdapterSafetyScenarios["transport"] = {
      "timeout-before-dispatch": { calls: fixture.fake.calls, execute: () => fail("oauth", "timeout-before-dispatch") },
      "provider-5xx-before-dispatch": { calls: fixture.fake.calls, execute: () => fail("oauth", "provider-5xx") },
      "timeout-after-dispatch": { calls: fixture.fake.calls, execute: () => fail("transaction", "timeout-after-dispatch") },
      "redelivery-409": { calls: fixture.fake.calls, execute: () => fail("transaction", "redelivery-409") },
    };
    function fail(call: string, kind: "timeout-before-dispatch" | "provider-5xx" | "timeout-after-dispatch" | "redelivery-409") {
      const status = kind === "provider-5xx" ? 503 : 409;
      fixture.configureFailure(call, kind.startsWith("timeout") ? { kind } : { kind,
        response: { ok: false, status, json: async () => ({}), text: async () => JSON.stringify({ errors: [{ errorCode: "general" }] }) } });
      return createTpayPaymentAdapter(fixture.config).attemptPort.execute(input);
    }
    return { ...subject, safety: { transport, capabilityInputs, missingRequiredInput: { ...input, payer: undefined },
      unsupportedCurrencyInput: { ...input, money: { ...input.money, currency: "ZZZ" } },
      partialMoney: { amountMinor: 500, currency: "PLN" }, webhooks: {
        valid, duplicate: { ...valid, input: { ...valid.input, receivedAt: new Date((subject.timestamp + 60) * 1000).toISOString() } },
        signatureMismatch: { input: { ...valid.input, rawBody: Buffer.from("tampered") }, expected: { kind: "refusal", reason: "signature" } },
        partialAmount: verification("TRUE", "succeeded", { tr_paid: "5.00" }),
        zeroAmount: verification("TRUE", "succeeded", { tr_paid: "0.00", tr_amount: "0.00" }),
        missingAmount: verification("TRUE", "succeeded", { tr_paid: undefined, tr_amount: undefined }),
        missingCurrency: verification("TRUE", "succeeded", { tr_currency: undefined }),
        chargeback: verification("CHARGEBACK", "refunded"),
      } } };
  });
  return { ...fixture, subjects };
}
