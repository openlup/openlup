import { describe, expect, it, vi } from "vitest";
import {
  createPaymentProviderRegistry,
  createPostgresProviderPaymentRail,
  createVerifiedPaymentIngress,
} from "@openlup/platform/payments";
import {
  createAdyenHttpClient,
  createAdyenPaymentAdapter,
} from "../server/index.js";
import {
  ADYEN_TEST_CANARIES,
  ADYEN_TEST_MERCHANT_ACCOUNT,
  ADYEN_TEST_RETURN_URL,
  buildSignedAdyenWebhook,
} from "./fixtures.js";

/**
 * Stage 3 Real-Flow Mount Proof (provider recipe contract, four-stage proof):
 * Uses ONLY public `@openlup/platform/payments` exports so this proof executes
 * identically inside the monorepo, after `git subtree split`, and inside any
 * adopter's standalone store repository.
 */
describe("recipes/payments/adyen — Stage 3 real-flow mount proof (+ negative controls)", () => {
  it("mounts Adyen into PaymentProviderRegistry and settles via createVerifiedPaymentIngress with replay dedupe", async () => {
    const adyenAdapter = createAdyenPaymentAdapter({
      client: createAdyenHttpClient({
        mode: "test",
        apiKey: ADYEN_TEST_CANARIES.apiKey,
        fetchImpl: async () => {
          throw new Error("no outbound HTTP expected during webhook settlement");
        },
      }),
      merchantAccount: ADYEN_TEST_MERCHANT_ACCOUNT,
      returnUrl: ADYEN_TEST_RETURN_URL,
      hmacKeysHex: [ADYEN_TEST_CANARIES.hmacKeyHex],
      mode: "test",
      supportedCurrencies: ["USD", "EUR"],
    });

    // 1. Mount into the official PaymentProviderRegistry.
    const registry = createPaymentProviderRegistry([adyenAdapter]);
    expect(registry.kinds()).toEqual(["adyen"]);
    expect(registry.railHandoffKinds("adyen")).toEqual(["client-confirmed", "redirect"]);
    expect(registry.readbackPorts()).toHaveProperty("adyen");
    const coreCapabilities = registry.asCapabilityRegistry();
    // Core repair-capture vocabulary maps client-confirmed -> embedded_client_secret (redirect stays rail-level).
    expect(coreCapabilities.get("adyen")?.captureFlows.map((f) => f.handoff)).toEqual([
      "embedded_client_secret",
    ]);

    // 2. Wire mounted adapter's verifyPort into createVerifiedPaymentIngress with in-memory ledger.
    const seenEvents = new Set<string>();
    const appliedKeys = new Set<string>();
    const appliedSettlements: Array<{ intentRef: string; status: string }> = [];
    const savedMethods: Array<{ methodRef: string; customerRef: string | null }> = [];

    const paymentControlPort: Parameters<typeof createVerifiedPaymentIngress>[0]["paymentControlPort"] = {
      async ingestPaymentEvent(input) {
        const key = `${input.provider}:${input.providerEventId}`;
        const replayed = seenEvents.has(key);
        seenEvents.add(key);
        return {
          paymentEventId: "evt_row_1",
          paymentIntentId: input.paymentIntentId ?? "intent-us-checkout-1",
          paymentAttemptId: input.paymentAttemptId ?? "attempt-us-checkout-1",
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
            customerRef: input.reusableMethod.providerCustomerRef ?? null,
          });
        }
        return { replayed: false };
      },
    };

    const ingress = createVerifiedPaymentIngress({
      provider: "adyen",
      verifyPort: registry.requireAdapter("adyen").verifyPort,
      paymentControlPort,
      methodRefPort,
      resolveSavedMethodOwner: async () => ({ clientId: "client-us-1" }),
    });

    // Deliver signed Adyen AUTHORISATION webhook with recurring token -> settles order + stores reusable method.
    const signedWebhook = buildSignedAdyenWebhook({
      pspReference: "8836111122223333",
      merchantReference: "intent-us-checkout-1",
      intentRef: "intent-us-checkout-1",
      attemptRef: "attempt-us-checkout-1",
      amount: { value: 6499, currency: "USD" },
      eventCode: "AUTHORISATION",
      success: "true",
      paymentMethod: "visa",
      recurringDetailReference: "ADYEN_TOKEN_999",
      shopperReference: "shopper-us-1",
    });

    const first = await ingress.receive(signedWebhook);
    expect(first.status).toBe(200);
    expect(appliedSettlements).toEqual([
      { intentRef: "intent-us-checkout-1", status: "succeeded" },
    ]);
    expect(savedMethods).toEqual([{ methodRef: "ADYEN_TOKEN_999", customerRef: "shopper-us-1" }]);

    // Duplicate webhook delivery replays idempotently without re-applying settlement.
    const replay = await ingress.receive({ ...signedWebhook, receivedAt: "2030-06-15T12:02:00.000Z" });
    expect(replay.status).toBe(200);
    expect(appliedSettlements).toHaveLength(1);

    // Tampered signature refuses with HTTP 400 and zero ledger writes.
    const tampered = await ingress.receive(
      buildSignedAdyenWebhook({
        pspReference: "8836111122224444",
        merchantReference: "intent-us-checkout-2",
        intentRef: "intent-us-checkout-2",
        amount: { value: 6499, currency: "USD" },
        eventCode: "AUTHORISATION",
        success: "true",
        tamperSignature: true,
      }),
    );
    expect(tampered.status).toBe(400);
    expect(seenEvents.size).toBe(1);

    // NEGATIVE CONTROL #1: Detaching Adyen from the registry causes mount lookup to fail.
    const emptyRegistry = createPaymentProviderRegistry([]);
    expect(() => emptyRegistry.requireAdapter("adyen")).toThrow();

    // NEGATIVE CONTROL #2: Mounting with a mismatched HMAC key causes valid webhook settlement to fail (400).
    const misconfiguredAdapter = createAdyenPaymentAdapter({
      client: createAdyenHttpClient({
        mode: "test",
        apiKey: ADYEN_TEST_CANARIES.apiKey,
        fetchImpl: async () => {
          throw new Error("no outbound HTTP");
        },
      }),
      merchantAccount: ADYEN_TEST_MERCHANT_ACCOUNT,
      returnUrl: ADYEN_TEST_RETURN_URL,
      hmacKeysHex: ["aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"],
      mode: "test",
      supportedCurrencies: ["USD"],
    });
    const brokenIngress = createVerifiedPaymentIngress({
      provider: "adyen",
      verifyPort: misconfiguredAdapter.verifyPort,
      paymentControlPort,
    });
    const brokenResult = await brokenIngress.receive(signedWebhook);
    expect(brokenResult.status).toBe(400);
  });

  it("mounts Adyen into createPostgresProviderPaymentRail and proves TransientSecret never enters PostgreSQL SQL parameters", async () => {
    const fetchSpy = vi.fn(async () =>
      new Response(
        JSON.stringify({
          id: "CS_US_CHECKOUT_42",
          sessionData: ADYEN_TEST_CANARIES.sessionData,
          amount: { currency: "USD", value: 4999 },
          reference: "11111111-1111-4111-8111-111111111111",
          expiresAt: "2030-06-15T13:00:00.000Z",
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      ),
    );

    const adapter = createAdyenPaymentAdapter({
      client: createAdyenHttpClient({
        mode: "test",
        apiKey: ADYEN_TEST_CANARIES.apiKey,
        fetchImpl: fetchSpy,
      }),
      merchantAccount: ADYEN_TEST_MERCHANT_ACCOUNT,
      returnUrl: ADYEN_TEST_RETURN_URL,
      hmacKeysHex: [ADYEN_TEST_CANARIES.hmacKeyHex],
      mode: "test",
      supportedCurrencies: ["USD"],
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
      money: { amountMinor: 4999, currency: "USD" },
      mode: "test",
      purpose: "initial",
      orderMode: "one_time",
      orderRef: "ORD-US-42",
      clientId: "client-1",
      customerRef: "shopper-us-42",
      saveForFutureUse: true,
    });

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(executed.execution.handoff?.kind).toBe("client-confirmed");
    expect(recordedQueries.some((q) => q.sql.includes("payment_provider_attempt_prepare"))).toBe(true);
    expect(recordedQueries.some((q) => q.sql.includes("payment_provider_attempt_finalize"))).toBe(true);

    // Proof: Transient sessionData and API key NEVER cross into PostgreSQL SQL parameters.
    const serializedSql = JSON.stringify(recordedQueries);
    expect(serializedSql).not.toContain(ADYEN_TEST_CANARIES.sessionData);
    expect(serializedSql).not.toContain(ADYEN_TEST_CANARIES.apiKey);

    // NEGATIVE CONTROL #3: Unsupported currency refuses BEFORE PostgreSQL finalize & with 0 Adyen HTTP calls.
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
    ).rejects.toThrow("Unsupported Adyen payment input: ADYEN_UNSUPPORTED_CURRENCY");
    expect(fetchSpy.mock.calls.length).toBe(callsBefore);
  });
});
