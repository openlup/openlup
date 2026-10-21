import { createHash, X509Certificate } from "node:crypto";
import { expect, it, vi } from "vitest";
import { runPaymentAdapterConformance } from "../../../src/payments/index.js";
import { createTpayPaymentAdapter, type TpayPaymentAdapterConfig } from "../../../src/payments/tpay/index.js";
import type { PaymentAttemptPort, TransientSecret, VerifiedPaymentEvidence } from "../../../src/payments/contracts/index.js";
import { createTpayJwsFixture } from "./webhookJws.testFixtures.js";

type Subject = Parameters<typeof runPaymentAdapterConformance>[0][number];
// Temporary local input bridge until M07 P3 supplies payer/method fields.
type AttemptInput = Parameters<PaymentAttemptPort["execute"]>[0] & {
  payer?: { email: string; name?: string };
  methodSelection?: { family: "bank-redirect" | "one-time-code"; channelRef?: string };
};

it("conforms across two distinct attempts with replay, chargeback and verification refusals", async () => {
  const certificate = createTpayJwsFixture(7);
  const timestamp = Date.parse(new X509Certificate(certificate.signingCertificatePem).validFrom) / 1000 + 10;
  const occurredAt = new Date(timestamp * 1000).toISOString();
  const fixtures = [
    { intentRef: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", attemptRef: "attempt-a", remote: "api-a", title: "TR-A", amountMinor: 2599 },
    { intentRef: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb", attemptRef: "attempt-b", remote: "api-b", title: "TR-B", amountMinor: 7300 },
  ];
  const fetch: TpayPaymentAdapterConfig["http"]["fetchImpl"] = vi.fn(async (url, init) => {
    let data: unknown;
    if (url.endsWith("/oauth/auth")) data = { access_token: "synthetic-token", expires_in: 7200 };
    else if (url.endsWith("/transactions") && init?.method === "POST") {
      const request = JSON.parse(init.body!);
      const fixture = fixtures.find(row => row.intentRef === request.hiddenDescription);
      if (!fixture) throw new Error("unexpected execution subject");
      expect(request).toMatchObject({ amount: fixture.amountMinor / 100, currency: "PLN" });
      data = { transactionId: fixture.remote, title: fixture.title, status: "pending",
        transactionPaymentUrl: `https://example.test/pay/${fixture.remote}`, payments: { errors: [] } };
    } else if (url.endsWith("/payments")) data = { payments: { attempts: [] } };
    else {
      const fixture = fixtures.find(row => url.endsWith(`/transactions/${row.remote}`));
      if (!fixture) throw new Error("unexpected readback subject");
      data = { transactionId: fixture.remote, title: fixture.title, status: "correct",
        amount: fixture.amountMinor / 100, paidAmount: fixture.amountMinor / 100, currency: "PLN" };
    }
    return { ok: true, status: 200, json: async () => data, text: async () => "" };
  });
  const adapter = createTpayPaymentAdapter({ http: { baseUrl: "https://api.example.test", clientId: "synthetic-client",
    clientSecret: "synthetic-secret", fetchImpl: fetch }, notification: { rootCertificatePem: certificate.rootCertificatePem,
    allowedCertificateUrlPrefix: "https://secure.sandbox.tpay.com/", resolveCertificate: async () => certificate.signingCertificatePem },
  urls: { notificationUrl: "https://example.test/notify", successUrl: "https://example.test/ok", errorUrl: "https://example.test/error" },
  modelOActivationEnabled: true, mode: "test", clock: () => timestamp });
  const subjects: Subject[] = fixtures.map((fixture, index) => {
    const money = { amountMinor: fixture.amountMinor, currency: "PLN" };
    const identity = { provider: "tpay", providerPaymentRef: fixture.remote, intentRef: fixture.intentRef, attemptRef: fixture.attemptRef };
    function verification(status: string, outcome: VerifiedPaymentEvidence["outcome"]) {
      const amount = (money.amountMinor / 100).toFixed(2);
      const rawBody = JSON.stringify({ tr_id: fixture.title, tr_status: status, tr_amount: amount, tr_paid: amount,
        tr_currency: money.currency, tr_crc: fixture.intentRef, payer: `transient-${fixture.remote}@example.test`,
        customerAuthorization: "572913", handoff: `transient-handoff-${fixture.remote}` });
      const input = { rawBody: Buffer.from(rawBody), headers: { "x-jws-signature": certificate.signature(rawBody, undefined, timestamp) }, receivedAt: occurredAt };
      const normalized: Omit<VerifiedPaymentEvidence, "fingerprint" | "providerAuditPayload"> = {
        provider: "tpay", providerOccurredAt: occurredAt, kind: "money", providerEventId: `${fixture.title}:${outcome}`,
        providerPaymentRef: fixture.title, intentRef: fixture.intentRef, attemptRef: null, outcome, money,
        ...(outcome === "refunded" ? { refund: { kind: "full-reversal", reason: "chargeback",
          operationId: `${fixture.title}:chargeback`, originalPaymentMoney: money } } : {}),
      };
      const expected: VerifiedPaymentEvidence = { ...normalized,
        fingerprint: createHash("sha256").update(JSON.stringify(normalized)).digest("hex"),
        providerAuditPayload: { provider: "tpay", eventKind: "transaction", transactionTitle: fixture.title,
          hiddenDescription: fixture.intentRef, transactionAmount: amount, paidAmount: amount, currency: "PLN", status, testMode: null },
      };
      return { input, expected };
    }
    const success = verification("TRUE", "succeeded");
    const chargeback = verification("CHARGEBACK", "refunded");
    const missingMoney = JSON.stringify({ tr_id: fixture.title, tr_status: "CHARGEBACK", tr_amount: "invalid", tr_paid: "25.99", tr_currency: "PLN" });
    const executionInput: AttemptInput = { intentRef: fixture.intentRef, attemptRef: fixture.attemptRef,
      fingerprint: `fingerprint-${fixture.attemptRef}`, providerIdempotencyKey: `key-${fixture.attemptRef}`,
      money, mode: "test", purpose: "initial", payer: { email: `transient-${fixture.remote}@example.test` },
      methodSelection: index === 0 ? { family: "bank-redirect", channelRef: "42" } : { family: "one-time-code" },
      ...(index === 1 ? { customerAuthorization: "572913" as TransientSecret } : {}),
    };
    return { subjectId: fixture.attemptRef, adapter, executionInput,
      readbackInput: { identity, expectedMoney: money, purpose: "active_checkout" },
      verification: [success, { ...success, input: { ...success.input, receivedAt: new Date((timestamp + 60) * 1000).toISOString() } },
        verification("FALSE", "failed"), chargeback,
        { input: { ...success.input, headers: {} }, expected: { kind: "refusal", reason: "signature" } },
        { input: { ...success.input, rawBody: Buffer.from(missingMoney), headers: { "x-jws-signature": certificate.signature(missingMoney, undefined, timestamp) } },
          expected: { kind: "refusal", reason: "malformed" } },
        { input: { ...success.input, receivedAt: new Date((timestamp + 7 * 24 * 60 * 60 + 1) * 1000).toISOString() }, expected: { kind: "refusal", reason: "stale" } },
      ],
    };
  });
  const evidence = await runPaymentAdapterConformance(subjects);
  expect(evidence.subjects.map(row => row.subjectId)).toEqual(["attempt-a", "attempt-b"]);
  expect(evidence.cases).toHaveLength(2);
  for (const [index, subject] of evidence.subjects.entries()) {
    expect(subject.execution).toMatchObject({ dispatch: { kind: "dispatched", providerPaymentRef: fixtures[index].remote } });
    expect(subject.readback).toMatchObject({ kind: "succeeded", identity: subjects[index].readbackInput.identity,
      observedMoney: subjects[index].readbackInput.expectedMoney });
    expect(subject.execution).not.toHaveProperty("handoff");
    expect(evidence.cases[index].passed).toBe(true);
    expect(JSON.stringify(evidence)).not.toContain(`transient-${fixtures[index].remote}`);
    expect(JSON.stringify(evidence)).not.toContain(`https://example.test/pay/${fixtures[index].remote}`);
  }
  expect(JSON.stringify(evidence)).not.toContain("572913");
  expect(adapter.absencePort).toBeUndefined();
  expect(adapter.readbackPort.close).toBeUndefined();
});
