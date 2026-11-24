import { describe, expect, it, vi } from "vitest";
import {
  createPaymentProviderRegistry,
  createPostgresProviderPaymentRail,
  createVerifiedPaymentIngress,
} from "@openlup/platform/payments";
import {
  createMollieHttpClient,
  createMolliePaymentAdapter,
  MOLLIE_API_ORIGIN,
} from "../server/index.js";
import {
  buildMollieWebhookInput,
  MOLLIE_TEST_CANARIES,
  MOLLIE_TEST_EXPIRES_AT,
  MOLLIE_TEST_OCCURRED_AT,
  MOLLIE_TEST_REDIRECT_URL,
  MOLLIE_TEST_WEBHOOK_URL,
} from "./fixtures.js";

/**
 * Stage 3 Real-Flow Mount Proof (provider recipe contract):
 * Uses ONLY public `@openlup/platform/payments` exports compatible with `@openlup/platform@^1.3.0`.
 */
describe("recipes/payments/mollie — Stage 3 real-flow mount proof (+ negative controls)", () => {
  it("mounts Mollie into PaymentProviderRegistry and settles via createVerifiedPaymentIngress with readback auth and replay dedupe", async () => {
    const fetchSpy = vi.fn(async (url: string | URL) => {
      const target = String(url);
      if (target === `${MOLLIE_API_ORIGIN}/v2/payments/tr_mountpaid01`) {
        return new Response(
          JSON.stringify({
            resource: "payment",
            id: "tr_mountpaid01",
            mode: "test",
            status: "paid",
            amount: { value: "64.99", currency: "EUR" },
            method: "creditcard",
            sequenceType: "first",
            customerId: "cst_eu_1",
            mandateId: "mdt_eu_999",
            paidAt: MOLLIE_TEST_OCCURRED_AT,
            metadata: {
              intentRef: "intent-eu-checkout-1",
              attemptRef: "attempt-eu-checkout-1",
            },
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }
      return new Response(JSON.stringify({ status: 404, title: "Not Found" }), {
        status: 404,
        headers: { "content-type": "application/json" },
      });
    });

    const mollieAdapter = createMolliePaymentAdapter({
      client: createMollieHttpClient({
        mode: "test",
        apiKey: MOLLIE_TEST_CANARIES.apiKeyTest,
        fetchImpl: fetchSpy,
      }),
      redirectUrl: MOLLIE_TEST_REDIRECT_URL,
      webhookUrl: MOLLIE_TEST_WEBHOOK_URL,
      mode: "test",
      supportedCurrencies: ["EUR", "USD"],
    });

    // 1. Mount into the official PaymentProviderRegistry.
    const registry = createPaymentProviderRegistry([mollieAdapter]);
    expect(registry.kinds()).toEqual(["mollie"]);
    expect(registry.railHandoffKinds("mollie")).toEqual(["redirect"]);
    expect(registry.readbackPorts()).toHaveProperty("mollie");
    const coreCapabilities = registry.asCapabilityRegistry();
    expect(coreCapabilities.get("mollie")?.captureFlows).toEqual([]);

    // 2. Wire mounted adapter's verifyPort into createVerifiedPaymentIngress.
    const seenEvents = new Set<string>();
    const appliedKeys = new Set<string>();
    const appliedSettlements: Array<{ intentRef: string; status: string }> = [];
    const savedMethods: Array<{
      methodRef: string;
      mandateRef: string | null;
      customerRef: string | null;
    }> = [];

    const paymentControlPort: Parameters<typeof createVerifiedPaymentIngress>[0]["paymentControlPort"] = {
      async ingestPaymentEvent(input) {
        const key = `${input.provider}:${input.providerEventId}`;
        const replayed = seenEvents.has(key);
        seenEvents.add(key);
        return {
          paymentEventId: "evt_row_1",
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

    const methodRefPort: NonNullable<Parameters<typeof createVerifiedPaymentIngress>[0]["methodRefPort"]> = {
      async upsertFromWebhook(input) {
        if (input.reusableMethod) {
          savedMethods.push({
            methodRef: input.reusableMethod.providerMethodRef,
            mandateRef: input.reusableMethod.providerMandateRef ?? null,
            customerRef: input.reusableMethod.providerCustomerRef ?? null,
          });
        }
        return { replayed: false };
      },
    };

    const ingress = createVerifiedPaymentIngress({
      provider: "mollie",
      verifyPort: registry.requireAdapter("mollie").verifyPort,
      paymentControlPort,
      methodRefPort,
      resolveSavedMethodOwner: async () => ({ clientId: "client-eu-1" }),
    });

    // Valid readback-authenticated webhook settles once and stores reusable mandate.
    const validWebhook = buildMollieWebhookInput("tr_mountpaid01");
    const first = await ingress.receive(validWebhook);
    expect(first.status).toBe(200);
    expect(appliedSettlements).toEqual([
      { intentRef: "intent-eu-checkout-1", status: "succeeded" },
    ]);
    expect(savedMethods).toEqual([
      { methodRef: "mdt_eu_999", mandateRef: "mdt_eu_999", customerRef: "cst_eu_1" },
    ]);

    // Duplicate webhook delivery replays idempotently without re-applying settlement.
    const replay = await ingress.receive(
      buildMollieWebhookInput("tr_mountpaid01", "2030-06-15T12:02:00.000Z"),
    );
    expect(replay.status).toBe(200);
    expect(appliedSettlements).toHaveLength(1);

    // Forged webhook ID returning 404 from Mollie refuses with HTTP 400 and zero writes.
    const forged = await ingress.receive(buildMollieWebhookInput("tr_forged404"));
    expect(forged.status).toBe(400);
    expect(seenEvents.size).toBe(1);

    // NEGATIVE CONTROL #1: Detaching Mollie from the registry causes mount lookup to fail.
    const emptyRegistry = createPaymentProviderRegistry([]);
    expect(() => emptyRegistry.requireAdapter("mollie")).toThrow();
  });

  it("mounts Mollie into createPostgresProviderPaymentRail and enforces zero-I/O negative controls", async () => {
    const fetchSpy = vi.fn(async () =>
      new Response(
        JSON.stringify({
          resource: "payment",
          id: "tr_pg_checkout_42",
          mode: "test",
          status: "open",
          amount: { value: "49.99", currency: "EUR" },
          sequenceType: "first",
          createdAt: MOLLIE_TEST_OCCURRED_AT,
          expiresAt: MOLLIE_TEST_EXPIRES_AT,
          _links: {
            checkout: { href: "https://www.mollie.com/checkout/select-method/tr_pg_checkout_42" },
          },
        }),
        { status: 201, headers: { "content-type": "application/json" } },
      ),
    );

    const adapter = createMolliePaymentAdapter({
      client: createMollieHttpClient({
        mode: "test",
        apiKey: MOLLIE_TEST_CANARIES.apiKeyTest,
        fetchImpl: fetchSpy,
      }),
      redirectUrl: MOLLIE_TEST_REDIRECT_URL,
      webhookUrl: MOLLIE_TEST_WEBHOOK_URL,
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
      customerRef: "cst_eu_42",
      saveForFutureUse: true,
      payer: { email: MOLLIE_TEST_CANARIES.payerEmail, name: MOLLIE_TEST_CANARIES.payerName },
    });

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(executed.execution.handoff).toEqual({
      kind: "redirect",
      url: "https://www.mollie.com/checkout/select-method/tr_pg_checkout_42",
    });
    expect(recordedQueries.some((q) => q.sql.includes("payment_provider_attempt_prepare"))).toBe(true);
    expect(recordedQueries.some((q) => q.sql.includes("payment_provider_attempt_finalize"))).toBe(true);

    // Proof: API key and payer PII NEVER cross into PostgreSQL SQL parameters.
    const serializedSql = JSON.stringify(recordedQueries);
    for (const canary of [
      MOLLIE_TEST_CANARIES.apiKeyTest,
      MOLLIE_TEST_CANARIES.payerEmail,
      MOLLIE_TEST_CANARIES.payerName,
    ]) {
      expect(serializedSql).not.toContain(canary);
      expect(serializedSql).not.toContain(encodeURIComponent(canary));
      expect(serializedSql).not.toContain(Buffer.from(canary, "utf8").toString("base64"));
    }

    // NEGATIVE CONTROL #2: Mismatched live_ key in test mode refuses at 0 I/O.
    const mismatchedFetchSpy = vi.fn(async () => {
      throw new Error("should not be called on mode/key mismatch");
    });
    expect(() =>
      createMollieHttpClient({
        mode: "test",
        apiKey: MOLLIE_TEST_CANARIES.apiKeyLive,
        fetchImpl: mismatchedFetchSpy,
      }),
    ).toThrow("MOLLIE_KEY_MODE_MISMATCH");
    const lazyMismatchAdapter = createMolliePaymentAdapter({
      client: createMollieHttpClient({
        mode: "test",
        apiKey: () => MOLLIE_TEST_CANARIES.apiKeyLive,
        fetchImpl: mismatchedFetchSpy,
      }),
      redirectUrl: MOLLIE_TEST_REDIRECT_URL,
      mode: "test",
      supportedCurrencies: ["EUR"],
    });
    const mismatchedExec = await lazyMismatchAdapter.attemptPort.execute({
      attemptRef: "att-live-key",
      intentRef: intentId,
      fingerprint: "fp-live-key",
      providerIdempotencyKey: "idem-live-key",
      money: { amountMinor: 4999, currency: "EUR" },
      mode: "test",
      purpose: "initial",
    });
    expect(mismatchedExec.dispatch.kind).toBe("notDispatched");
    expect(mismatchedExec.diagnostics.diagnosticCode).toBe("MOLLIE_KEY_MODE_MISMATCH");
    expect(mismatchedFetchSpy).not.toHaveBeenCalled();

    // NEGATIVE CONTROL #3: Unsupported currency refuses BEFORE PostgreSQL prepare/finalize & with 0 Mollie HTTP calls.
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
    ).rejects.toThrow("Unsupported Mollie payment input: MOLLIE_UNSUPPORTED_CURRENCY");
    expect(fetchSpy.mock.calls.length).toBe(callsBefore);
  });
});
