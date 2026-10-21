import { X509Certificate } from "node:crypto";
import { beforeAll, expect, it, vi } from "vitest";
import { createTpayPaymentAdapter, tpayPaymentCapabilities, type TpayPaymentAdapterConfig } from "../../../src/payments/tpay/index.js";
import * as donorExecution from "../../../src/payments/tpay/tpayPaymentExecutionAdapter.js";
import { ProviderAttemptPreDispatchError, type TrustedProviderAttemptNoChargeFailure } from "../../../src/payments/tpay/preparedProviderAttempt.js";
import { TpayTransactionDispatchError } from "../../../src/payments/tpay/tpayDispatchFailure.js";
import { createTpayJwsFixture } from "./webhookJws.testFixtures.js";
import { projectVerifiedEvidence } from "../../../src/payments/verifiedEvidenceProjection.js";
import { readMethodLifecycleEvent } from "../../../src/payments/index.js";
import type { PaymentAttemptPort, TransientSecret } from "../../../src/payments/contracts/index.js";

type AttemptInput = Parameters<PaymentAttemptPort["execute"]>[0];
const payer = { email: "planted-71c3@example.test", name: "Planted Person 71c3" };
const authorization = "572913" as TransientSecret;
function attemptInput(): AttemptInput {
  return { attemptRef: "attempt-1", intentRef: "intent-1", fingerprint: "fingerprint-1", providerIdempotencyKey: "key-1",
    money: { amountMinor: 2599, currency: "PLN" }, mode: "test", purpose: "initial", payer,
    methodSelection: { family: "bank-redirect", channelRef: "42" } };
}
function dispatchConfig(declined = false) {
  const good = config();
  const fetch = vi.fn(async (url: string, _init?: Parameters<TpayPaymentAdapterConfig["http"]["fetchImpl"]>[1]) => ({
    ok: true, status: 200, text: async () => "", json: async () => url.endsWith("/oauth/auth")
      ? { access_token: "fixture", expires_in: 7200 }
      : url.endsWith("/transactions") ? { transactionId: "api-1", title: "TR-1", status: "pending",
        transactionPaymentUrl: "https://example.test/pay", payments: { errors: declined
          ? [{ errorCode: "unknown", errorMessage: `${payer.email} ${payer.name} ${authorization}` }] : [] } }
      : { payments: { attempts: [] } },
  }));
  good.http.fetchImpl = fetch;
  return { good, fetch, request: () => JSON.parse(fetch.mock.calls.find(([url]) => url.endsWith("/transactions"))![1]!.body!) };
}
function expectRedacted(result: unknown) {
  for (const value of [payer.email, payer.name, authorization]) expect(JSON.stringify(result)).not.toContain(value);
  expect(result).not.toHaveProperty("requestPayload");
  expect(result).not.toHaveProperty("responsePayload");
}

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
  for (const value of [tpayPaymentCapabilities, tpayPaymentCapabilities.captureFlows,
    ...tpayPaymentCapabilities.captureFlows, ...tpayPaymentCapabilities.captureFlows.map(flow => flow.methodFamilies),
    tpayPaymentCapabilities.supportedCurrencies, tpayPaymentCapabilities.payerContext,
    tpayPaymentCapabilities.methodHealth, tpayPaymentCapabilities.terminalOutcomeReporting]) expect(Object.isFrozen(value)).toBe(true);
  expect(adapter.capabilities.supportedCurrencies).toEqual(["PLN"]);
  expect(adapter.capabilities.assessMandate({ recurringModel: "O" })).toEqual({ chargeable: true });
  for (const recurringModel of ["M", undefined, "unknown"]) expect(adapter.capabilities.assessMandate({ recurringModel }).chargeable).toBe(false);
  expect(adapter.absencePort).toBeUndefined(); expect(adapter.readbackPort.close).toBeUndefined();
  expect(adapter.capabilities.refundCreate).toBe("unsupported");
  expect(adapter.capabilities.authorizationCaptureSplit).toBe("unsupported");
  expect(adapter.capabilities.captureFlows.map(flow => flow.kind)).toEqual(["bank_redirect", "one_time_code"]);
});
it("dispatches a bank redirect with the selected channel and transient payer", async () => {
  const { good, fetch, request } = dispatchConfig();
  const adapter = createTpayPaymentAdapter(good);
  adapter.attemptPort.validateInput(attemptInput());
  expect(fetch).not.toHaveBeenCalled();
  const result = await adapter.attemptPort.execute(attemptInput());
  expect(result).toMatchObject({ outcome: { kind: "attempt", status: "processing" },
    dispatch: { kind: "dispatched", providerPaymentRef: "api-1" }, handoff: { kind: "redirect", url: "https://example.test/pay" } });
  expect(request()).toMatchObject({ payer, hiddenDescription: "intent-1", description: "intent-1", amount: 25.99,
    currency: "PLN", pay: { channelId: "42" } });
  expectRedacted(result); expectRedacted(result.diagnostics);
});
it.each([undefined, "", "  \t "])("dispatches a one-time code with a neutral label for payer name %s", async name => {
  const { good, request } = dispatchConfig();
  const result = await createTpayPaymentAdapter(good).attemptPort.execute({ ...attemptInput(), payer: { email: payer.email, name },
    methodSelection: { family: "one-time-code" }, customerAuthorization: authorization });
  expect(result).toMatchObject({ dispatch: { kind: "dispatched", providerPaymentRef: "api-1" } });
  expect(result.handoff).toBeUndefined();
  expect(request()).toMatchObject({ payer: { email: payer.email, name: "Customer" }, pay: { groupId: 150, blikPaymentData: { blikToken: authorization } } });
  expectRedacted(result); expectRedacted(result.diagnostics);
});
it("dispatches an unattended Model O alias with explicit transient payer", async () => {
  const { good, request } = dispatchConfig();
  const result = await createTpayPaymentAdapter(good).attemptPort.execute({ ...attemptInput(), purpose: "renewal-unattended",
    methodSelection: undefined, storedMethod: { reference: "alias-1", mandate: { recurringModel: "O" } } });
  expect(result).toMatchObject({ outcome: { kind: "attempt" }, dispatch: { kind: "dispatched", providerPaymentRef: "api-1" } });
  expect(result.handoff).toBeUndefined();
  expect(request()).toMatchObject({ payer, pay: { blikPaymentData: { type: 2,
    aliases: { value: "alias-1", type: "PAYID", noDelay: true, recommendedAuthLevel: "NOCONFREQ" } } } });
  expectRedacted(result); expectRedacted(result.diagnostics);
});
it("refuses missing payer before any dispatch, including unattended attempts", async () => {
  const good = config(); const adapter = createTpayPaymentAdapter(good);
  for (const purpose of ["initial", "renewal-unattended"] as const) {
    const input = { ...attemptInput(), purpose, payer: undefined, storedMethod: { reference: "alias-1", mandate: { recurringModel: "O" } } };
    expect(() => adapter.attemptPort.validateInput(input)).toThrow("Invalid payment input");
    const result = await adapter.attemptPort.execute(input);
    expect(result).toMatchObject({ outcome: { kind: "decline", refusal: { code: "fix_and_retry_customer_action", hints: ["dataInvalid"] } },
      dispatch: { kind: "notDispatched", evidence: { exact: true, phase: "before-dispatch", reason: { code: "fix_and_retry_customer_action" } } } });
    expectRedacted(result);
  }
  expect(good.http.fetchImpl).not.toHaveBeenCalled();
});
it("refuses missing channel or authorization and unsupported families before dispatch", async () => {
  const good = config(); const adapter = createTpayPaymentAdapter(good);
  for (const methodSelection of [{ family: "bank-redirect" }, { family: "one-time-code" }, { family: "card" }, { family: "wallet" }, undefined] as const) {
    const input = { ...attemptInput(), methodSelection };
    expect(() => adapter.attemptPort.validateInput(input)).toThrow();
    expect(await adapter.attemptPort.execute(input)).toMatchObject({ outcome: { kind: "decline" },
      dispatch: { kind: "notDispatched", evidence: { exact: true, phase: "before-dispatch" } } });
  }
  expect(good.http.fetchImpl).not.toHaveBeenCalled();
});
it.each(["M", undefined, "unknown"])("refuses mandate model %s before dispatch", async recurringModel => {
  const good = config(); const adapter = createTpayPaymentAdapter(good);
  const input = { ...attemptInput(), purpose: "renewal-unattended" as const,
    storedMethod: { reference: "alias-1", mandate: { recurringModel } } };
  expect(() => adapter.attemptPort.validateInput(input)).toThrow();
  expect(await adapter.attemptPort.execute(input)).toMatchObject({ outcome: { kind: "decline" },
    dispatch: { kind: "notDispatched", evidence: { exact: true, phase: "before-dispatch" } } });
  expect(good.http.fetchImpl).not.toHaveBeenCalled();
});
it("keeps provider refusal prose and payer out of the complete returned decline envelope", async () => {
  const { good } = dispatchConfig(true);
  const result = await createTpayPaymentAdapter(good).attemptPort.execute({ ...attemptInput(),
    methodSelection: { family: "one-time-code" }, customerAuthorization: authorization });
  expect(result).toMatchObject({ outcome: { kind: "decline", refusal: { code: "indeterminate" } },
    dispatch: { kind: "dispatched", providerPaymentRef: "api-1" } });
  expect(result.handoff).toBeUndefined();
  expectRedacted(result); expectRedacted(result.diagnostics);
});
const trustedFailures: TrustedProviderAttemptNoChargeFailure[] = [
  { phase: "oauth", code: "tpay_oauth_failed", dispatchState: "not_dispatched" },
  { phase: "oauth", code: "tpay_oauth_timeout", dispatchState: "not_dispatched" },
  { phase: "oauth", code: "tpay_oauth_invalid_response", dispatchState: "not_dispatched" },
  { phase: "transaction_dispatch", code: "tpay_request_encode_failed", dispatchState: "not_dispatched" },
  { phase: "transaction_dispatch", code: "tpay_request_deadline_exhausted", dispatchState: "not_dispatched" },
  { phase: "response_decode", code: "tpay_request_refused", dispatchState: "refused" },
];
it.each(trustedFailures)("maps trusted $code to exact no-dispatch without leaking transient input", async failure => {
  const error = new ProviderAttemptPreDispatchError(failure);
  const spy = vi.spyOn(donorExecution, "createTpayPaymentExecutionAdapter").mockReturnValueOnce({
    validateInput: () => {}, execute: async () => { throw error; },
  });
  let adapter;
  try { adapter = createTpayPaymentAdapter(config()); } finally { spy.mockRestore(); }
  const result = await adapter.attemptPort.execute({ ...attemptInput(),
    methodSelection: { family: "one-time-code" }, customerAuthorization: authorization });
  const reason = { code: "soft_retryable", hints: ["transient"] };
  expect(result).toEqual({ outcome: { kind: "decline", refusal: reason },
    dispatch: { kind: "notDispatched", evidence: { exact: true, phase: "before-dispatch", reason } }, diagnostics: {} });
  expectRedacted(result);
});
it("maps real OAuth failures and provider document refusals without returning provider prose", async () => {
  for (const failOAuth of [true, false]) {
    const good = config();
    const fetch = vi.fn(async (url: string) => {
      const oauth = url.endsWith("/oauth/auth");
      const payload = oauth && !failOAuth ? { access_token: "fixture", expires_in: 7200 }
        : { result: "failed", errors: [{ errorCode: "not_valid", fieldName: "payer.email",
          errorMessage: `${payer.email} ${payer.name} ${authorization}` }] };
      return { ok: oauth && !failOAuth, status: oauth && !failOAuth ? 200 : 400,
        text: async () => JSON.stringify(payload), json: async () => payload };
    });
    good.http.fetchImpl = fetch;
    const result = await createTpayPaymentAdapter(good).attemptPort.execute({ ...attemptInput(),
      methodSelection: { family: "one-time-code" }, customerAuthorization: authorization });
    expect(result).toMatchObject({ outcome: { kind: "decline", refusal: { code: "soft_retryable", hints: ["transient"] } },
      dispatch: { kind: "notDispatched", evidence: { exact: true, phase: "before-dispatch" } } });
    expect(fetch).toHaveBeenCalledTimes(failOAuth ? 1 : 2);
    expectRedacted(result);
  }
});
it("propagates ambiguous and lookalike errors unchanged", async () => {
  for (const error of [new TpayTransactionDispatchError({ phase: "transaction_dispatch",
    code: "tpay_transport_failed", dispatchState: "unknown" }),
    Object.assign(new Error("untrusted"), trustedFailures[0])]) {
    const spy = vi.spyOn(donorExecution, "createTpayPaymentExecutionAdapter").mockReturnValueOnce({
      validateInput: () => {}, execute: async () => { throw error; },
    });
    let adapter;
    try { adapter = createTpayPaymentAdapter(config()); } finally { spy.mockRestore(); }
    await expect(adapter.attemptPort.execute(attemptInput())).rejects.toBe(error);
  }
});
it("keeps an actual transaction transport loss ambiguous", async () => {
  const good = config();
  good.http.fetchImpl = vi.fn(async url => {
    if (!url.endsWith("/oauth/auth")) throw new Error("transport lost");
    return { ok: true, status: 200, text: async () => "", json: async () => ({ access_token: "fixture", expires_in: 7200 }) };
  });
  await expect(createTpayPaymentAdapter(good).attemptPort.execute(attemptInput())).rejects.toMatchObject({
    name: "TpayTransactionDispatchError", dispatchState: "unknown", code: "tpay_transport_failed",
  });
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
it("bounds future signed issue time at the default and configured clock skew", async () => {
  for (const skew of [undefined, 0, 60]) {
    const good = config();
    good.notification.maxClockSkewSeconds = skew;
    const adapter = createTpayPaymentAdapter(good);
    const limit = skew ?? 300;
    expect(await verify(adapter, body(), instant + limit)).toMatchObject({ kind: "money",
      providerOccurredAt: new Date((instant + limit) * 1000).toISOString() });
    expect(await verify(adapter, body(), instant + limit + 1)).toEqual({ kind: "refusal", reason: "stale" });
  }
  for (const maxClockSkewSeconds of [-1, NaN, Infinity]) {
    const good = config(); good.notification.maxClockSkewSeconds = maxClockSkewSeconds;
    expect(() => createTpayPaymentAdapter(good)).toThrow("Invalid payment configuration");
    expect(good.http.fetchImpl).not.toHaveBeenCalled();
  }
});
it("deduplicates receipt-independent fingerprints while separating transaction outcomes", async () => {
  const adapter = createTpayPaymentAdapter(config());
  const first = await verify(adapter);
  expect(await verify(adapter, body(), undefined, "2030-01-01T00:00:00Z")).toEqual(first);
  const failed = await verify(adapter, body("FALSE"));
  expect(failed).toMatchObject({ kind: "money", outcome: "failed", providerEventId: "TR-1:failed" });
  expect(failed).not.toEqual(first);
});
it("carries only donor-filtered audit facts outside identity and fingerprints", async () => {
  const adapter = createTpayPaymentAdapter(config());
  const planted = { payer: "audit-payer-71c3@example.test", customerAuthorization: "audit-authorization-71c3",
    client_secret: "audit-secret-71c3", handoff: "audit-handoff-71c3", certificate: fixture.signingCertificatePem,
    failureReason: "audit-unfiltered-prose-71c3", decline_code: "audit-unfiltered-decline-71c3",
    status_description: "audit-unfiltered-status-71c3", failureEvidence: { source: "unproven-input-71c3" } };
  const transaction = { tr_id: "TR-1", tr_status: "FALSE", tr_amount: "25.99", tr_paid: "25.99", tr_currency: "PLN" };
  const clean = await verify(adapter, JSON.stringify(transaction));
  const observed = await verify(adapter, JSON.stringify({ ...transaction, ...planted }));
  expect(observed).toEqual(clean);
  expect(observed).toMatchObject({ kind: "money", providerAuditPayload: {
    provider: "tpay", eventKind: "transaction", transactionTitle: "TR-1", status: "FALSE",
    transactionAmount: "25.99", paidAmount: "25.99", currency: "PLN", testMode: null, hiddenDescription: null,
  } });
  const alias = await verify(adapter, JSON.stringify({ event: "ALIAS_UPDATE", msg_value: { value: "alias-1", type: "PAYID" }, ...planted }));
  expect(alias).toMatchObject({ kind: "method", providerAuditPayload: {
    provider: "tpay", eventKind: "blik_alias", event: "ALIAS_UPDATE", aliasType: "PAYID",
    paymentIntentId: null, aliasValuePresent: true, aliasExpirationDatePresent: false,
  } });
  const changed = await verify(adapter, body("false"));
  expect(changed).toMatchObject({ kind: "money", providerAuditPayload: { status: "false" } });
  if (clean.kind === "refusal" || changed.kind === "refusal") throw new Error("expected verified money");
  expect(changed.providerEventId).toBe(clean.providerEventId);
  expect(changed.fingerprint).toBe(clean.fingerprint);
  for (const evidence of [observed, alias]) {
    for (const value of Object.values(planted)) {
      const sensitive = typeof value === "string" ? value : value.source;
      expect(JSON.stringify(evidence)).not.toContain(JSON.stringify(sensitive).slice(1, -1));
    }
    expect(evidence).not.toHaveProperty("providerAuditPayload.failureEvidence");
    expect(evidence).not.toHaveProperty("providerAuditPayload.failureReason");
    expect(evidence).not.toHaveProperty("providerAuditPayload.decline_code");
    expect(evidence).not.toHaveProperty("providerAuditPayload.status_description");
    expect(evidence).not.toHaveProperty("providerAuditPayload.msg_value[type]");
  }
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
    const adapter = createTpayPaymentAdapter(config());
    const rawBody = `event=${event}&msg_value[value]=alias-1`;
    const result = await verify(adapter, rawBody, instant - 10);
    expect(result).toMatchObject({ kind: "method", outcome, providerEventId: `${event}:alias-1:${outcome}`,
      methodRef: "alias-1", providerOccurredAt: new Date((instant - 10) * 1000).toISOString(),
      methodLifecycle: { kind: `method_${outcome}`, providerKind: "tpay", providerMethodRef: "alias-1",
        providerEventId: `${event}:alias-1`, occurredAt: new Date((instant - 10) * 1000).toISOString(), replacement: null } });
    const withoutTime = await verify(adapter, rawBody);
    expect(withoutTime).toMatchObject({ kind: "method", outcome, providerOccurredAt: null });
    expect(withoutTime).not.toHaveProperty("methodLifecycle");
    expect(await verify(adapter, rawBody, undefined, "2030-01-01T00:00:00Z")).toEqual(withoutTime);
  });
it("preserves signed alias lifecycle through M07 projection and omits it without provider time", async () => {
  const adapter = createTpayPaymentAdapter(config());
  for (const [event, kind] of [["ALIAS_REGISTER", "method_registered"], ["ALIAS_UPDATE", "method_updated"],
    ["ALIAS_UNREGISTER", "method_revoked"], ["ALIAS_EXPIRED", "method_expired"]]) {
    const rawBody = `event=${event}&msg_value[value]=alias-1`;
    for (const asserted of [instant - 10, undefined]) {
      const input = { rawBody: Buffer.from(rawBody),
        headers: { "x-jws-signature": fixture.signature(rawBody, undefined, asserted) },
        receivedAt: new Date(instant * 1000).toISOString() };
      const result = await adapter.verifyPort.verifyAndNormalize(input);
      if (result.kind !== "method") throw new Error("expected method evidence");
      const projected = projectVerifiedEvidence(result, input, "require-evidence");
      expect(projected.occurredAt).toBe(input.receivedAt);
      expect(readMethodLifecycleEvent(projected)).toEqual(asserted === undefined ? null : {
        kind, providerKind: "tpay", providerMethodRef: "alias-1", providerEventId: `${event}:alias-1`,
        occurredAt: new Date(asserted * 1000).toISOString(), replacement: null,
      });
      expect(await adapter.verifyPort.verifyAndNormalize({ ...input,
        receivedAt: new Date((instant + 30) * 1000).toISOString() })).toEqual(result);
    }
  }
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
it.each(["refunded", "chargeback"].flatMap(status =>
  (["active_checkout", "recovery"] as const).flatMap(purpose => [
    { status, purpose, history: "none", payments: {} },
    { status, purpose, history: "attempt refusal", payments: { attempts: [{ paymentErrorCode: "51" }] } },
    { status, purpose, history: "error refusal", payments: { errors: [{ errorCode: "51" }] } },
  ])))("keeps $status $purpose readback with $history unknown for host manual review", async ({ status, purpose, payments }) => {
  const good = config();
  good.http.fetchImpl = vi.fn(async url => ({ ok: true, status: 200, text: async () => "",
    json: async () => url.endsWith("/oauth/auth") ? { access_token: "fixture", expires_in: 7200 }
      : { transactionId: "api-1", title: "TR-1", status, payments, amount: 25.99, currency: "PLN" } }));
  expect(await createTpayPaymentAdapter(good).readbackPort.readPayment({ identity: {
    provider: "tpay", providerPaymentRef: "api-1", intentRef: "intent", attemptRef: "attempt" },
  expectedMoney: { amountMinor: 2599, currency: "PLN" }, purpose })).toMatchObject({ kind: "unknown", reason: "indeterminate" });
});
