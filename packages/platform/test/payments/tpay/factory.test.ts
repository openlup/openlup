import { X509Certificate } from "node:crypto";
import { beforeAll, expect, it, vi } from "vitest";
import { createTpayPaymentAdapter, tpayPaymentCapabilities, type TpayPaymentAdapterConfig } from "../../../src/payments/tpay/index.js";
import { createTpayJwsFixture } from "./webhookJws.testFixtures.js";

let fixture: ReturnType<typeof createTpayJwsFixture>;
let instant: number;
beforeAll(() => {
  fixture = createTpayJwsFixture(7);
  instant = Date.parse(new X509Certificate(fixture.signingCertificatePem).validFrom) / 1000 + 10;
});
const prefix = "https://secure.sandbox.tpay.com/";
function config(): TpayPaymentAdapterConfig {
  return { http: { baseUrl: "https://api.example.test", clientId: "synthetic-client", clientSecret: "synthetic-secret",
    fetchImpl: vi.fn(async () => { throw Error("unexpected dispatch"); }) },
  notification: { rootCertificatePem: fixture.rootCertificatePem, allowedCertificateUrlPrefix: prefix,
    resolveCertificate: vi.fn(async () => fixture.signingCertificatePem) },
  urls: { notificationUrl: "https://example.test/notify", successUrl: "https://example.test/ok", errorUrl: "https://example.test/error" },
  modelOActivationEnabled: true, mode: "test", clock: () => instant };
}
const body = (status = "TRUE", extra = "") => `tr_id=TR-1&tr_status=${status}&tr_amount=25.99&tr_paid=25.99&tr_currency=PLN${extra}`;
function verify(adapter: ReturnType<typeof createTpayPaymentAdapter>, rawBody = body(), iat?: number, receivedAt = new Date(instant * 1000).toISOString()) {
  return adapter.verifyPort.verifyAndNormalize({ rawBody: Buffer.from(rawBody),
    headers: { "X-JWS-Signature": fixture.signature(rawBody, undefined, iat) }, receivedAt });
}

it("requires root/prefix/resolver configuration and refuses invalid prefixes before I/O", () => {
  const good = config();
  expect(() => createTpayPaymentAdapter(good)).not.toThrow();
  for (const notification of [undefined, { ...good.notification, rootCertificatePem: undefined },
    { ...good.notification, allowedCertificateUrlPrefix: undefined }, { ...good.notification, resolveCertificate: undefined },
    { ...good.notification, allowedCertificateUrlPrefix: "http://example.test/" },
    { ...good.notification, allowedCertificateUrlPrefix: "https://example.test" }]) {
    expect(() => createTpayPaymentAdapter({ ...good, notification } as TpayPaymentAdapterConfig)).toThrow();
  }
  expect(good.http.fetchImpl).not.toHaveBeenCalled();
});
it("declares only the witnessed market, Model O, observations and no exact absence or close", () => {
  const adapter = createTpayPaymentAdapter(config());
  expect(adapter.capabilities).toEqual(tpayPaymentCapabilities);
  expect(adapter.capabilities.supportedCurrencies).toEqual(["PLN"]);
  expect(adapter.capabilities.assessMandate({ recurringModel: "O" })).toEqual({ chargeable: true });
  for (const recurringModel of ["M", undefined, "unknown"]) expect(adapter.capabilities.assessMandate({ recurringModel }).chargeable).toBe(false);
  expect(adapter.absencePort).toBeUndefined(); expect(adapter.readbackPort.close).toBeUndefined();
  expect(adapter.capabilities.refundCreate).toBe("unsupported");
  expect(adapter.capabilities.authorizationCaptureSplit).toBe("unsupported");
});
it("verifies exact signed bytes and retains null provider time without a signed assertion", async () => {
  const adapter = createTpayPaymentAdapter(config());
  expect(await verify(adapter)).toMatchObject({ kind: "money", outcome: "succeeded", providerEventId: "TR-1:succeeded",
    providerOccurredAt: null, money: { amountMinor: 2599, currency: "PLN" } });
  const rawBody = body();
  expect(await adapter.verifyPort.verifyAndNormalize({ rawBody: Buffer.from(rawBody + " "),
    headers: { "x-jws-signature": fixture.signature(rawBody) }, receivedAt: new Date().toISOString() })).toEqual({ kind: "refusal", reason: "signature" });
});
it.each(["expired", "not-yet-valid"])("refuses %s signing/root certificates as signature", async direction => {
  const cert = new X509Certificate(fixture.signingCertificatePem);
  const current = direction === "expired" ? Date.parse(cert.validTo) / 1000 + 1 : Date.parse(cert.validFrom) / 1000 - 1;
  const adapter = createTpayPaymentAdapter({ ...config(), clock: () => current });
  expect(await verify(adapter)).toEqual({ kind: "refusal", reason: "signature" });
});
it("checks the trust anchor validity window", async () => {
  const cert = new X509Certificate(fixture.rootCertificatePem);
  const adapter = createTpayPaymentAdapter({ ...config(), clock: () => Date.parse(cert.validTo) / 1000 + 1 });
  expect(await verify(adapter)).toEqual({ kind: "refusal", reason: "signature" });
});
it("checks signed notification age and preserves the asserted time", async () => {
  const adapter = createTpayPaymentAdapter({ ...config(), notification: { ...config().notification, maxNotificationAgeSeconds: 60 } });
  expect(await verify(adapter, body(), instant - 60)).toMatchObject({ kind: "money", providerOccurredAt: new Date((instant - 60) * 1000).toISOString() });
  expect(await verify(adapter, body(), instant - 61)).toEqual({ kind: "refusal", reason: "stale" });
  expect(await verify(adapter, body(), instant - 61, "invalid")).toEqual({ kind: "refusal", reason: "malformed" });
});
it("deduplicates receipt-independent fingerprints while separating transaction outcomes", async () => {
  const adapter = createTpayPaymentAdapter(config());
  const first = await verify(adapter);
  expect(await verify(adapter, body(), undefined, "2030-01-01T00:00:00Z")).toEqual(first);
  const failed = await verify(adapter, body("FALSE"));
  expect(failed).toMatchObject({ kind: "money", outcome: "failed", providerEventId: "TR-1:failed" });
  expect(failed).not.toEqual(first);
});
it("observes chargeback as full reversal with stable operation identity and original money", async () => {
  const adapter = createTpayPaymentAdapter(config());
  const raw = body("CHARGEBACK");
  const observed = await verify(adapter, raw);
  expect(observed).toMatchObject({ kind: "money", outcome: "refunded", providerEventId: "TR-1:refunded",
    refund: { kind: "full-reversal", reason: "chargeback", operationId: "TR-1:chargeback",
      originalPaymentMoney: { amountMinor: 2599, currency: "PLN" } } });
  expect(await verify(adapter, raw)).toEqual(observed);
  expect(await verify(adapter, raw.replace("&tr_currency=PLN", ""))).toEqual({ kind: "refusal", reason: "malformed" });
  expect(await verify(adapter, raw.replace("tr_amount=25.99", "tr_amount=invalid"))).toEqual({ kind: "refusal", reason: "malformed" });
});
it.each([["ALIAS_REGISTER", "registered"], ["ALIAS_UPDATE", "updated"], ["ALIAS_UNREGISTER", "revoked"], ["ALIAS_EXPIRED", "expired"]])(
  "keeps %s as method evidence with outcome-specific identity", async (event, outcome) => {
    expect(await verify(createTpayPaymentAdapter(config()), `event=${event}&msg_value[value]=alias-1`)).toMatchObject({
      kind: "method", outcome, providerEventId: `${event}:alias-1:${outcome}`, methodRef: "alias-1", providerOccurredAt: null });
  });
it("refuses unsupported alias outcomes and malformed bodies without inventing money/time", async () => {
  const adapter = createTpayPaymentAdapter(config());
  expect(await verify(adapter, "event=UNRECOGNIZED&msg_value[value]=alias-1")).toEqual({ kind: "refusal", reason: "unsupported-event" });
  expect(await verify(adapter, "tr_status=TRUE")).toEqual({ kind: "refusal", reason: "malformed" });
  expect(await verify(adapter, body().replace("&tr_currency=PLN", ""))).toMatchObject({ kind: "money", money: null });
});
it("refuses mode mismatch, missing signature and forbidden certificate resolution", async () => {
  const good = config(); const adapter = createTpayPaymentAdapter(good);
  expect(await verify(adapter, body("TRUE", "&test_mode=0"))).toEqual({ kind: "refusal", reason: "unsupported-event" });
  expect(await adapter.verifyPort.verifyAndNormalize({ rawBody: Buffer.from(body()), headers: {}, receivedAt: "invalid" })).toEqual({ kind: "refusal", reason: "signature" });
  expect(await adapter.verifyPort.verifyAndNormalize({ rawBody: Buffer.from(body()), headers: {
    "x-jws-signature": fixture.signature(body(), "https://outside.example.test/cert.pem") }, receivedAt: "invalid" })).toEqual({ kind: "refusal", reason: "signature" });
  expect(good.notification.resolveCertificate).toHaveBeenCalledTimes(1);
});

it("preserves purpose and exact identity/money checks on readback", async () => {
  const good = config();
  const response = { transactionId: "api-1", title: "TR-1", status: "correct", amount: "25.99", paidAmount: "25.99", currency: "PLN" };
  good.http.fetchImpl = vi.fn(async url => ({ ok: true, status: 200, text: async () => "",
    json: async () => url.endsWith("/oauth/auth") ? { access_token: "fixture", expires_in: 7200 } : response }));
  const adapter = createTpayPaymentAdapter(good);
  const identity = { provider: "tpay", providerPaymentRef: "api-1", intentRef: "intent", attemptRef: "attempt" };
  const expectedMoney = { amountMinor: 2599, currency: "PLN" };
  for (const purpose of ["active_checkout", "recovery"] as const) {
    const input = { identity, expectedMoney, purpose };
    const result = await adapter.readbackPort.readPayment(input);
    expect(result).toMatchObject({ kind: "succeeded", purpose, providerOccurredAt: null });
    expect(result.identity).toBe(identity); expect(result.expectedMoney).toBe(expectedMoney);
  }
  expect(await adapter.readbackPort.readPayment({ identity, expectedMoney: { ...expectedMoney, amountMinor: 1 }, purpose: "recovery" }))
    .toMatchObject({ kind: "unknown", reason: "indeterminate" });
  response.transactionId = "wrong";
  expect(await adapter.readbackPort.readPayment({ identity, expectedMoney, purpose: "recovery" })).toMatchObject({ kind: "unknown" });
  response.transactionId = "api-1"; response.amount = "invalid";
  expect(await adapter.readbackPort.readPayment({ identity, expectedMoney: { ...expectedMoney, amountMinor: 0 }, purpose: "recovery" }))
    .toMatchObject({ kind: "unknown" });
});
it.each(["refunded", "chargeback"])("keeps %s readback unknown for host manual review", async status => {
  const good = config();
  good.http.fetchImpl = vi.fn(async url => ({ ok: true, status: 200, text: async () => "",
    json: async () => url.endsWith("/oauth/auth") ? { access_token: "fixture", expires_in: 7200 }
      : { transactionId: "api-1", title: "TR-1", status, amount: 25.99, currency: "PLN" } }));
  expect(await createTpayPaymentAdapter(good).readbackPort.readPayment({ identity: {
    provider: "tpay", providerPaymentRef: "api-1", intentRef: "intent", attemptRef: "attempt" },
  expectedMoney: { amountMinor: 2599, currency: "PLN" }, purpose: "recovery" })).toMatchObject({ kind: "unknown", reason: "indeterminate" });
});
