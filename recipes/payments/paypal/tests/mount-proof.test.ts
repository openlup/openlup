import { describe, expect, it, vi } from "vitest";
import {
  createPaymentProviderRegistry,
  createPostgresProviderPaymentRail,
  createVerifiedPaymentIngress,
} from "@openlup/platform/payments";
import {
  createPayPalHttpClient,
  createPayPalPaymentAdapter,
  PAYPAL_API_ORIGINS,
} from "../server/index.js";
import {
  buildPayPalWebhookInput,
  PAYPAL_TEST_CANARIES,
  PAYPAL_TEST_CANCEL_URL,
  PAYPAL_TEST_OCCURRED_AT,
  PAYPAL_TEST_RETURN_URL,
  PAYPAL_TEST_WEBHOOK_ID,
} from "./fixtures.js";

/**
 * Stage 3 Real-Flow Mount Proof (ADR-001):
 * Uses ONLY public `@openlup/platform/payments` exports.
 */
describe("recipes/payments/paypal — Stage 3 real-flow mount proof (+ negative controls)", () => {
  it("mounts PayPal into PaymentProviderRegistry and settles via createVerifiedPaymentIngress with readback auth and replay dedupe", async () => {
    const fetchSpy = vi.fn(async (url: string | URL, init?: RequestInit) => {
      const target = String(url);
      if (target === `${PAYPAL_API_ORIGINS.test}/v1/oauth2/token`) {
        return new Response(
          JSON.stringify({ access_token: "mount-oauth-tok", token_type: "Bearer", expires_in: 3600 }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }
      if (target === `${PAYPAL_API_ORIGINS.test}/v1/notifications/verify-webhook-signature`) {
        const body = JSON.parse(String(init?.body ?? "{}")) as { transmission_sig?: string; webhook_id?: string };
        const ok = body.webhook_id === PAYPAL_TEST_WEBHOOK_ID && body.transmission_sig === "valid-paypal-sig";
        return new Response(
          JSON.stringify({ verification_status: ok ? "SUCCESS" : "FAILURE" }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }
      if (target === `${PAYPAL_API_ORIGINS.test}/v2/checkout/orders/5O190127TN364715M`) {
        return new Response(
          JSON.stringify({
            id: "5O190127TN364715M",
            status: "COMPLETED",
            purchase_units: [
              {
                reference_id: "attempt-eu-checkout-1",
                custom_id: "intent-eu-checkout-1",
                amount: { value: "64.99", currency_code: "EUR" },
                payments: {
                  captures: [
                    {
                      id: "CAP-5O190127TN364715M",
                      status: "COMPLETED",
                      amount: { value: "64.99", currency_code: "EUR" },
                      update_time: PAYPAL_TEST_OCCURRED_AT,
                    },
                  ],
                },
              },
            ],
            update_time: PAYPAL_TEST_OCCURRED_AT,
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }
      return new Response(JSON.stringify({ name: "RESOURCE_NOT_FOUND" }), {
        status: 404,
        headers: { "content-type": "application/json" },
      });
    });

    const paypalAdapter = createPayPalPaymentAdapter({
      client: createPayPalHttpClient({
        mode: "test",
        credentials: {
          clientId: PAYPAL_TEST_CANARIES.clientId,
          clientSecret: PAYPAL_TEST_CANARIES.clientSecret,
        },
        fetchImpl: fetchSpy,
      }),
      webhookId: PAYPAL_TEST_WEBHOOK_ID,
      returnUrl: PAYPAL_TEST_RETURN_URL,
      cancelUrl: PAYPAL_TEST_CANCEL_URL,
      mode: "test",
      supportedCurrencies: ["EUR", "USD"],
    });

    // 1. Mount into the official PaymentProviderRegistry.
    const registry = createPaymentProviderRegistry([paypalAdapter]);
    expect(registry.kinds()).toEqual(["paypal"]);
    expect(registry.railHandoffKinds("paypal")).toEqual(["redirect"]);
    expect(registry.readbackPorts()).toHaveProperty("paypal");

    // 2. Wire mounted adapter's verifyPort into createVerifiedPaymentIngress.
    const seenEvents = new Set<string>();
    const appliedKeys = new Set<string>();
    const appliedSettlements: Array<{ intentRef: string; status: string }> = [];

    const paymentControlPort: Parameters<typeof createVerifiedPaymentIngress>[0]["paymentControlPort"] = {
      async ingestPaymentEvent(input) {
        const key = `${input.provider}:${input.providerEventId}`;
        const replayed = seenEvents.has(key);
        seenEvents.add(key);
        return {
          paymentEventId: "evt_paypal_row_1",
          paymentIntentId: input.paymentIntentId ?? "intent-eu-checkout-1",
          paymentAttemptId: input.paymentAttemptId ?? "attempt-eu-checkout-1",
          replayed,
          occurredAt: input.occurredAt,
        };
      },
      async applyPaymentResult(input) {
        const replayed = appliedKeys.has(input.idempotencyKey);
        if (!replayed) {
          appliedKeys.add(input.idempotencyKey);
          appliedSettlements.push({
            intentRef: input.paymentIntentId,
            status: input.resultStatus,
          });
        }
        return { replayed, kind: replayed ? "replayed" : "applied" };
      },
    };

    const ingress = createVerifiedPaymentIngress({
      provider: "paypal",
      verifyPort: registry.requireAdapter("paypal").verifyPort,
      paymentControlPort,
    });

    const validWebhook = buildPayPalWebhookInput({
      orderId: "5O190127TN364715M",
      eventType: "PAYMENT.CAPTURE.COMPLETED",
      useSupplementaryOrderId: true,
    });
    const first = await ingress.receive(validWebhook);
    expect(first.status).toBe(200);
    expect(appliedSettlements).toEqual([
      { intentRef: "intent-eu-checkout-1", status: "succeeded" },
    ]);

    const replay = await ingress.receive(
      buildPayPalWebhookInput(
        {
          orderId: "5O190127TN364715M",
          eventType: "PAYMENT.CAPTURE.COMPLETED",
          useSupplementaryOrderId: true,
        },
        "2030-06-15T12:02:00.000Z",
      ),
    );
    expect(replay.status).toBe(200);
    expect(appliedSettlements).toHaveLength(1);

    // Forged order ID returning 404 from PayPal refuses with HTTP 400 and zero writes.
    const forged = await ingress.receive(
      buildPayPalWebhookInput({ orderId: "5O190127FORGED404" }),
    );
    expect(forged.status).toBe(400);
    expect(seenEvents.size).toBe(1);

    // NEGATIVE CONTROL #1: Detaching PayPal from the registry causes lookup to fail.
    const emptyRegistry = createPaymentProviderRegistry([]);
    expect(() => emptyRegistry.requireAdapter("paypal")).toThrow();
  });

  it("mounts PayPal into createPostgresProviderPaymentRail and enforces zero-I/O negative controls", async () => {
    const fetchSpy = vi.fn(async (url: string | URL) => {
      if (String(url).includes("/v1/oauth2/token")) {
        return new Response(
          JSON.stringify({ access_token: "pg-oauth-tok", token_type: "Bearer", expires_in: 3600 }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }
      return new Response(
        JSON.stringify({
          id: "TEST_ORDER_0001",
          status: "CREATED",
          links: [
            { rel: "approve", href: "https://www.sandbox.paypal.com/checkoutnow?token=TEST_ORDER_0001" },
          ],
          create_time: PAYPAL_TEST_OCCURRED_AT,
        }),
        { status: 201, headers: { "content-type": "application/json" } },
      );
    });

    const adapter = createPayPalPaymentAdapter({
      client: createPayPalHttpClient({
        mode: "test",
        credentials: {
          clientId: PAYPAL_TEST_CANARIES.clientId,
          clientSecret: PAYPAL_TEST_CANARIES.clientSecret,
        },
        fetchImpl: fetchSpy,
      }),
      webhookId: PAYPAL_TEST_WEBHOOK_ID,
      returnUrl: PAYPAL_TEST_RETURN_URL,
      cancelUrl: PAYPAL_TEST_CANCEL_URL,
      mode: "test",
      supportedCurrencies: ["EUR"],
    });

    const recordedQueries: Array<{ sql: string; params: readonly unknown[] }> = [];
    const attemptId = "22222222-2222-4222-8222-222222222222";
    const intentId = "11111111-1111-4111-8111-111111111111";

    const executor: Parameters<typeof createPostgresProviderPaymentRail>[0]["executor"] = {
      async query(sql, params = []) {
        recordedQueries.push({ sql, params });
        if (sql.includes("payment_provider_attempt_prepare")) {
          return {
            rows: [
              {
                response: {
                  paymentAttempt: {
                    id: attemptId,
                    status: "created",
                    replayed: false,
                    providerAttemptId: null,
                    providerSessionId: null,
                    nextActionKind: null,
                  },
                },
              },
            ],
          } as never;
        }
        if (sql.includes("payment_provider_attempt_finalize")) {
          return {
            rows: [
              {
                response: {
                  paymentAttempt: {
                    id: attemptId,
                    status: params[7],
                    replayed: false,
                    providerAttemptId: params[5],
                    providerSessionId: params[6],
                    nextActionKind: params[8],
                  },
                },
              },
            ],
          } as never;
        }
        throw new Error(`Unexpected SQL in mount proof: ${sql}`);
      },
    };

    const rail = createPostgresProviderPaymentRail({
      executor,
      adapter,
      mode: "test",
      truth: {
        dunningTemplateSlug: "dunning-failed",
        recoveryTemplateSlug: "payment-recovered",
        recoveryUrlPath: "/account/recovery",
      },
      resolveMethodOwner: async () => ({ clientId: "client-1" }),
      resolveSavedMethodOwner: async () => ({ clientId: "client-1" }),
    });

    const executed = await rail.execute({
      attemptRef: attemptId,
      intentRef: intentId,
      fingerprint: "fp-pg-1",
      providerIdempotencyKey: "idem-pg-1",
      money: { amountMinor: 4999, currency: "EUR" },
      mode: "test",
      purpose: "initial",
      orderMode: "one_time",
      orderRef: "ORD-EU-42",
      clientId: "client-1",
      payer: { email: PAYPAL_TEST_CANARIES.payerEmail, name: PAYPAL_TEST_CANARIES.payerName },
    });

    expect(fetchSpy).toHaveBeenCalledTimes(2); // OAuth2 token + createOrder
    expect(executed.execution.handoff).toEqual({
      kind: "redirect",
      url: "https://www.sandbox.paypal.com/checkoutnow?token=TEST_ORDER_0001",
    });
    expect(recordedQueries.some((q) => q.sql.includes("payment_provider_attempt_prepare"))).toBe(true);
    expect(recordedQueries.some((q) => q.sql.includes("payment_provider_attempt_finalize"))).toBe(true);

    // Proof: OAuth credentials and payer PII NEVER cross into PostgreSQL SQL parameters.
    const serializedSql = JSON.stringify(recordedQueries);
    for (const canary of [
      PAYPAL_TEST_CANARIES.marker,
      PAYPAL_TEST_CANARIES.clientId,
      PAYPAL_TEST_CANARIES.clientSecret,
      PAYPAL_TEST_CANARIES.payerEmail,
      PAYPAL_TEST_CANARIES.payerName,
    ]) {
      expect(serializedSql).not.toContain(canary);
      expect(serializedSql).not.toContain(encodeURIComponent(canary));
      expect(serializedSql).not.toContain(Buffer.from(canary, "utf8").toString("base64"));
    }

    // NEGATIVE CONTROL #2: Unsupported currency refuses BEFORE PostgreSQL prepare/finalize & with 0 PayPal HTTP calls.
    const callsBefore = fetchSpy.mock.calls.length;
    await expect(
      rail.execute({
        attemptRef: "33333333-3333-4333-8333-333333333333",
        intentRef: intentId,
        fingerprint: "fp-pg-jpy",
        providerIdempotencyKey: "idem-pg-jpy",
        money: { amountMinor: 4999, currency: "JPY" },
        mode: "test",
        purpose: "initial",
      }),
    ).rejects.toThrow("Unsupported PayPal payment input: PAYPAL_UNSUPPORTED_CURRENCY");
    expect(fetchSpy.mock.calls.length).toBe(callsBefore);
  });
});
