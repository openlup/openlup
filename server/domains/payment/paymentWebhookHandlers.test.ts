import { describe, expect, expectTypeOf, it, vi } from "vitest";
import { WebhookBodyTooLargeError } from "../../_lib/payment/webhookSignature.js";
import {
  PAYMENT_WEBHOOK_EVENT_TYPES,
  type CanonicalPaymentEvent,
} from "../../../src/domains/payment/types.js";
import {
  createProviderPaymentWebhookHandler,
  type ProviderPaymentWebhookKind,
} from "./paymentWebhookHandlers.js";

describe("provider payment webhook handlers", () => {
  it("shares the deployment webhook vocabulary with the canonical payment event", () => {
    expect(PAYMENT_WEBHOOK_EVENT_TYPES).toEqual([
      "payment.succeeded",
      "payment.failed",
      "payment.refunded",
      "payment.requires_action",
      "payment.disputed",
      "setup.succeeded",
      "setup.failed",
      "setup.requires_action",
    ]);
    expectTypeOf<ProviderPaymentWebhookKind>()
      .toEqualTypeOf<CanonicalPaymentEvent["event_type"]>();
  });

  it("rejects signature failures before persistence", async () => {
    const ingestPaymentEvent = vi.fn();
    const handler = createProviderPaymentWebhookHandler({
      provider: "stripe",
      webhooksEnabled: () => true,
      verifyAndNormalize: vi.fn().mockRejectedValue(new Error("bad signature")),
      paymentControlPort: { ingestPaymentEvent },
    });
    const res = createResponse();

    await handler({ method: "POST", body: {} } as never, res as never);

    expect(res.statusCode).toBe(400);
    expect(ingestPaymentEvent).not.toHaveBeenCalled();
  });

  it("acknowledges canonical event redelivery with the same deterministic payment-result key", async () => {
    const applyPaymentResult = vi.fn().mockResolvedValueOnce({ replayed: false }).mockResolvedValueOnce({ replayed: true });
    const afterProcessed = vi.fn();
    const event = stripeSucceededEvent();
    const handler = createProviderPaymentWebhookHandler({
      provider: "stripe",
      webhooksEnabled: () => true,
      verifyAndNormalize: vi.fn().mockResolvedValue(event),
      paymentControlPort: {
        ingestPaymentEvent: vi.fn()
          .mockResolvedValueOnce({
            paymentEventId: "11111111-1111-4111-8111-111111111111",
            paymentIntentId: "22222222-2222-4222-8222-222222222222",
            paymentAttemptId: "33333333-3333-4333-8333-333333333333",
            replayed: false,
          })
          .mockResolvedValueOnce({
            paymentEventId: "11111111-1111-4111-8111-111111111111",
            paymentIntentId: "22222222-2222-4222-8222-222222222222",
            paymentAttemptId: "33333333-3333-4333-8333-333333333333",
            replayed: true,
          }),
        applyPaymentResult,
      },
      afterProcessed,
    });
    const first = createResponse();
    const replay = createResponse();

    await handler({ method: "POST", body: {} } as never, first as never);
    await handler({ method: "POST", body: {} } as never, replay as never);

    expect(applyPaymentResult).toHaveBeenCalledTimes(2);
    expect(applyPaymentResult).toHaveBeenNthCalledWith(1, {
      idempotencyKey: "provider-webhook:stripe:evt_123:apply",
      paymentIntentId: "22222222-2222-4222-8222-222222222222",
      paymentEventId: "11111111-1111-4111-8111-111111111111",
      resultStatus: "succeeded",
      occurredAt: event.occurredAt,
      failureReason: null,
    });
    expect(applyPaymentResult).toHaveBeenNthCalledWith(2, expect.objectContaining({
      idempotencyKey: "provider-webhook:stripe:evt_123:apply",
      paymentEventId: "11111111-1111-4111-8111-111111111111",
    }));
    // Follow-up work intentionally runs on replay so a prior partial failure can
    // self-heal; it receives the same ledger row and explicit replay evidence.
    expect(afterProcessed).toHaveBeenNthCalledWith(2, expect.objectContaining({
      event,
      ingested: expect.objectContaining({
        paymentEventId: "11111111-1111-4111-8111-111111111111",
        replayed: true,
      }),
      resultStatus: "succeeded",
    }));
    expect(readData(first.body)).toMatchObject({ provider: "stripe", replayed: false });
    expect(readData(replay.body)).toMatchObject({ provider: "stripe", replayed: true });
  });

  it("applies a full charge.refunded as resultStatus 'refunded'", async () => {
    const applyPaymentResult = vi.fn().mockResolvedValue({ replayed: false });
    const handler = createProviderPaymentWebhookHandler({
      provider: "stripe",
      webhooksEnabled: () => true,
      verifyAndNormalize: vi.fn().mockResolvedValue(stripeRefundEvent("full")),
      paymentControlPort: {
        ingestPaymentEvent: vi.fn().mockResolvedValue({
          paymentEventId: "11111111-1111-4111-8111-111111111111",
          paymentIntentId: "22222222-2222-4222-8222-222222222222",
          paymentAttemptId: null,
          replayed: false,
        }),
        applyPaymentResult,
      },
    });

    await handler({ method: "POST", body: {} } as never, createResponse() as never);

    expect(applyPaymentResult).toHaveBeenCalledWith(
      expect.objectContaining({ resultStatus: "refunded" }),
    );
  });

  it("applies a partial charge.refunded as resultStatus 'partially_refunded'", async () => {
    const applyPaymentResult = vi.fn().mockResolvedValue({ replayed: false });
    const handler = createProviderPaymentWebhookHandler({
      provider: "stripe",
      webhooksEnabled: () => true,
      verifyAndNormalize: vi.fn().mockResolvedValue(stripeRefundEvent("partial")),
      paymentControlPort: {
        ingestPaymentEvent: vi.fn().mockResolvedValue({
          paymentEventId: "11111111-1111-4111-8111-111111111111",
          paymentIntentId: "22222222-2222-4222-8222-222222222222",
          paymentAttemptId: null,
          replayed: false,
        }),
        applyPaymentResult,
      },
    });

    await handler({ method: "POST", body: {} } as never, createResponse() as never);

    expect(applyPaymentResult).toHaveBeenCalledWith(
      expect.objectContaining({ resultStatus: "partially_refunded" }),
    );
  });

  it("maps reusable Tpay PAYID events to method refs without subscription lifecycle mutation", async () => {
    const upsertFromWebhook = vi.fn().mockResolvedValue({ replayed: false });
    const event = {
      provider: "tpay" as const,
      providerEventId: "evt_payid",
      eventType: "payment.requires_action" as const,
      providerPaymentId: "tr_123",
      occurredAt: "2026-06-06T12:00:00.000Z",
      rawPayload: { payid: "payid_123" },
      reusableMethod: {
        clientId: "44444444-4444-4444-8444-444444444444",
        providerMethodRef: "payid_123",
        methodKind: "blik_payid" as const,
        status: "active" as const,
      },
    };
    const handler = createProviderPaymentWebhookHandler({
      provider: "tpay",
      webhooksEnabled: () => true,
      verifyAndNormalize: vi.fn().mockResolvedValue(event),
      paymentControlPort: {
        ingestPaymentEvent: vi.fn().mockResolvedValue({
          paymentEventId: "11111111-1111-4111-8111-111111111111",
          paymentIntentId: null,
          paymentAttemptId: null,
          replayed: false,
        }),
      },
      methodRefPort: { upsertFromWebhook },
    });
    const res = createResponse();

    await handler({ method: "POST", body: {} } as never, res as never);

    expect(upsertFromWebhook).toHaveBeenCalledWith(event);
    expect(res.statusCode).toBe(200);
  });

  it("acknowledges an unsupported event type with 200 so the provider stops retrying", async () => {
    const ingestPaymentEvent = vi.fn();
    const handler = createProviderPaymentWebhookHandler({
      provider: "stripe",
      webhooksEnabled: () => true,
      verifyAndNormalize: vi
        .fn()
        .mockRejectedValue(new Error("Unsupported Stripe webhook event: invoice.created")),
      paymentControlPort: { ingestPaymentEvent },
    });
    const res = createResponse();

    await handler({ method: "POST", body: {} } as never, res as never);

    expect(res.statusCode).toBe(200);
    expect(readData(res.body)).toMatchObject({ skipped: "unsupported_event" });
    expect(ingestPaymentEvent).not.toHaveBeenCalled();
  });

  it("returns 413 when the webhook body exceeds the size cap", async () => {
    const handler = createProviderPaymentWebhookHandler({
      provider: "stripe",
      webhooksEnabled: () => true,
      verifyAndNormalize: vi.fn().mockRejectedValue(new WebhookBodyTooLargeError()),
      paymentControlPort: { ingestPaymentEvent: vi.fn() },
    });
    const res = createResponse();

    await handler({ method: "POST", body: {} } as never, res as never);

    expect(res.statusCode).toBe(413);
  });

  it("emits an out-of-band reconciliation signal for an unmatched succeeded Stripe payment (no local intent) without settling", async () => {
    const applyPaymentResult = vi.fn();
    const operationalEvents = vi.fn();
    const handler = createProviderPaymentWebhookHandler({
      provider: "stripe",
      webhooksEnabled: () => true,
      verifyAndNormalize: vi.fn().mockResolvedValue({ ...stripeSucceededEvent(), paymentIntentId: null }),
      paymentControlPort: {
        ingestPaymentEvent: vi.fn().mockResolvedValue({
          paymentEventId: "11111111-1111-4111-8111-111111111111",
          paymentIntentId: null,
          paymentAttemptId: null,
          replayed: false,
        }),
        applyPaymentResult,
      },
      operationalEvents,
    });
    const res = createResponse();

    await handler({ method: "POST", body: {} } as never, res as never);

    // Safe behavior preserved: no local intent => no settlement / phantom order.
    expect(applyPaymentResult).not.toHaveBeenCalled();
    expect(operationalEvents).toHaveBeenCalledTimes(1);
    expect(operationalEvents).toHaveBeenCalledWith({
      name: "provider_payment_unmatched_out_of_band",
      domain: "payment",
      surface: "webhook",
      details: {
        provider: "stripe",
        providerPaymentId: "pi_123",
        eventType: "payment.succeeded",
        resultStatus: "succeeded",
        amountMinor: 1490,
        currency: "PLN",
        occurredAt: "2026-06-06T12:00:00.000Z",
      },
    });
    expect(res.statusCode).toBe(200);
  });

  it("emits the out-of-band signal for an unmatched refunded Tpay payment (provider-neutral)", async () => {
    const operationalEvents = vi.fn();
    const handler = createProviderPaymentWebhookHandler({
      provider: "tpay",
      webhooksEnabled: () => true,
      verifyAndNormalize: vi.fn().mockResolvedValue({
        provider: "tpay" as const,
        providerEventId: "evt_oob_refund",
        eventType: "payment.refunded" as const,
        providerPaymentId: "tr_999",
        paymentIntentId: null,
        amountMinor: 4980,
        currency: "PLN",
        occurredAt: "2026-07-13T09:00:00.000Z",
        refundKind: "full" as const,
        rawPayload: { id: "evt_oob_refund" },
      }),
      paymentControlPort: {
        ingestPaymentEvent: vi.fn().mockResolvedValue({
          paymentEventId: "11111111-1111-4111-8111-111111111111",
          paymentIntentId: null,
          paymentAttemptId: null,
          replayed: false,
        }),
      },
      operationalEvents,
    });

    await handler({ method: "POST", body: {} } as never, createResponse() as never);

    expect(operationalEvents).toHaveBeenCalledWith(
      expect.objectContaining({
        name: "provider_payment_unmatched_out_of_band",
        details: expect.objectContaining({
          provider: "tpay",
          providerPaymentId: "tr_999",
          resultStatus: "refunded",
          eventType: "payment.refunded",
        }),
      }),
    );
  });

  it("does NOT emit the out-of-band signal when a local intent matched", async () => {
    const operationalEvents = vi.fn();
    const handler = createProviderPaymentWebhookHandler({
      provider: "stripe",
      webhooksEnabled: () => true,
      verifyAndNormalize: vi.fn().mockResolvedValue(stripeSucceededEvent()),
      paymentControlPort: {
        ingestPaymentEvent: vi.fn().mockResolvedValue({
          paymentEventId: "11111111-1111-4111-8111-111111111111",
          paymentIntentId: "22222222-2222-4222-8222-222222222222",
          paymentAttemptId: null,
          replayed: false,
        }),
        applyPaymentResult: vi.fn().mockResolvedValue({ replayed: false }),
      },
      operationalEvents,
    });

    await handler({ method: "POST", body: {} } as never, createResponse() as never);

    expect(operationalEvents).not.toHaveBeenCalled();
  });

  it("does NOT emit for an unmatched non-money event (failed / setup)", async () => {
    const operationalEvents = vi.fn();
    const handler = createProviderPaymentWebhookHandler({
      provider: "stripe",
      webhooksEnabled: () => true,
      verifyAndNormalize: vi.fn().mockResolvedValue({
        provider: "stripe" as const,
        providerEventId: "evt_oob_failed",
        eventType: "payment.failed" as const,
        providerPaymentId: "pi_failed",
        paymentIntentId: null,
        occurredAt: "2026-07-13T09:00:00.000Z",
        rawPayload: { id: "evt_oob_failed" },
      }),
      paymentControlPort: {
        ingestPaymentEvent: vi.fn().mockResolvedValue({
          paymentEventId: "11111111-1111-4111-8111-111111111111",
          paymentIntentId: null,
          paymentAttemptId: null,
          replayed: false,
        }),
        applyPaymentResult: vi.fn(),
      },
      operationalEvents,
    });

    await handler({ method: "POST", body: {} } as never, createResponse() as never);

    expect(operationalEvents).not.toHaveBeenCalled();
  });

  it("does NOT re-emit the out-of-band signal on an idempotent replay", async () => {
    const operationalEvents = vi.fn();
    const handler = createProviderPaymentWebhookHandler({
      provider: "stripe",
      webhooksEnabled: () => true,
      verifyAndNormalize: vi.fn().mockResolvedValue({ ...stripeSucceededEvent(), paymentIntentId: null }),
      paymentControlPort: {
        ingestPaymentEvent: vi.fn().mockResolvedValue({
          paymentEventId: "11111111-1111-4111-8111-111111111111",
          paymentIntentId: null,
          paymentAttemptId: null,
          replayed: true,
        }),
      },
      operationalEvents,
    });

    await handler({ method: "POST", body: {} } as never, createResponse() as never);

    expect(operationalEvents).not.toHaveBeenCalled();
  });

  it("maps a downstream idempotency conflict (SQLSTATE 23505) to 409, not a retryable 5xx", async () => {
    const handler = createProviderPaymentWebhookHandler({
      provider: "stripe",
      webhooksEnabled: () => true,
      verifyAndNormalize: vi.fn().mockResolvedValue(stripeSucceededEvent()),
      paymentControlPort: {
        ingestPaymentEvent: vi
          .fn()
          .mockRejectedValue(new Error("rpc: payment_method_ref_idempotency_conflict (23505)")),
      },
    });
    const res = createResponse();

    await handler({ method: "POST", body: {} } as never, res as never);

    expect(res.statusCode).toBe(409);
  });

  it("acknowledges a succeeded result that lost the race to the sweep (terminal intent) with 200, not a retryable 503", async () => {
    const operationalEvents = vi.fn();
    const handler = createProviderPaymentWebhookHandler({
      provider: "stripe",
      webhooksEnabled: () => true,
      verifyAndNormalize: vi.fn().mockResolvedValue(stripeSucceededEvent()),
      paymentControlPort: {
        ingestPaymentEvent: vi.fn().mockResolvedValue({
          paymentEventId: "11111111-1111-4111-8111-111111111111",
          paymentIntentId: "22222222-2222-4222-8222-222222222222",
          paymentAttemptId: null,
          replayed: false,
        }),
        applyPaymentResult: vi
          .fn()
          .mockRejectedValue(new Error("rpc: payment_control_result_terminal_intent (22023)")),
      },
      operationalEvents,
    });
    const res = createResponse();

    await handler({ method: "POST", body: {} } as never, res as never);

    expect(res.statusCode).toBe(200);
    expect(readData(res.body)).toMatchObject({ skipped: "result_terminal_intent" });
    expect(operationalEvents).toHaveBeenCalledWith(
      expect.objectContaining({ name: "provider_payment_result_after_terminal_intent" }),
    );
  });

  it("acknowledges a result that named a non-active payment attempt with 200 and records the anomaly", async () => {
    const operationalEvents = vi.fn();
    const handler = createProviderPaymentWebhookHandler({
      provider: "stripe",
      webhooksEnabled: () => true,
      verifyAndNormalize: vi.fn().mockResolvedValue(stripeSucceededEvent()),
      paymentControlPort: {
        ingestPaymentEvent: vi.fn().mockResolvedValue({
          paymentEventId: "11111111-1111-4111-8111-111111111111",
          paymentIntentId: "22222222-2222-4222-8222-222222222222",
          paymentAttemptId: null,
          replayed: false,
        }),
        applyPaymentResult: vi
          .fn()
          .mockRejectedValue(new Error("rpc: payment_control_result_attempt_mismatch (22023)")),
      },
      operationalEvents,
    });
    const res = createResponse();

    await handler({ method: "POST", body: {} } as never, res as never);

    // 200, because `active_attempt_id` only moves forward: redelivering this
    // event can never find a different answer, so a 503 would be an endless
    // loop. The anomaly is what makes the possible double charge visible.
    expect(res.statusCode).toBe(200);
    expect(readData(res.body)).toMatchObject({ skipped: "result_attempt_mismatch" });
    expect(operationalEvents).toHaveBeenCalledWith(
      expect.objectContaining({
        name: "provider_payment_result_attempt_mismatch",
        details: expect.objectContaining({ reason: "attempt_mismatch" }),
      }),
    );
  });

  it("acknowledges an event-present failed result with unresolved attempt attribution", async () => {
    const operationalEvents = vi.fn();
    const event = { ...stripeSucceededEvent(), eventType: "payment.failed" as const };
    const handler = createProviderPaymentWebhookHandler({
      provider: "stripe",
      webhooksEnabled: () => true,
      verifyAndNormalize: vi.fn().mockResolvedValue(event),
      paymentControlPort: {
        ingestPaymentEvent: vi.fn().mockResolvedValue({
          paymentEventId: "11111111-1111-4111-8111-111111111111",
          paymentIntentId: "22222222-2222-4222-8222-222222222222",
          paymentAttemptId: null,
          replayed: false,
        }),
        applyPaymentResult: vi
          .fn()
          .mockRejectedValue(new Error("rpc: payment_control_result_attempt_unresolved (22023)")),
      },
      operationalEvents,
    });
    const res = createResponse();

    await handler({ method: "POST", body: {} } as never, res as never);

    expect(res.statusCode).toBe(200);
    expect(readData(res.body)).toMatchObject({ skipped: "result_attempt_mismatch" });
    expect(operationalEvents).toHaveBeenCalledWith(
      expect.objectContaining({
        name: "provider_payment_result_attempt_mismatch",
        details: expect.objectContaining({
          reason: "attempt_unresolved",
          eventType: "payment.failed",
          resultStatus: "failed",
        }),
      }),
    );
  });

  it("still returns a retryable 503 for a genuine transient upstream error (not terminal-intent)", async () => {
    const handler = createProviderPaymentWebhookHandler({
      provider: "stripe",
      webhooksEnabled: () => true,
      verifyAndNormalize: vi.fn().mockResolvedValue(stripeSucceededEvent()),
      paymentControlPort: {
        ingestPaymentEvent: vi.fn().mockResolvedValue({
          paymentEventId: "11111111-1111-4111-8111-111111111111",
          paymentIntentId: "22222222-2222-4222-8222-222222222222",
          paymentAttemptId: null,
          replayed: false,
        }),
        applyPaymentResult: vi
          .fn()
          .mockRejectedValue(new Error("rpc: connection reset by peer")),
      },
    });
    const res = createResponse();

    await handler({ method: "POST", body: {} } as never, res as never);

    expect(res.statusCode).toBe(503);
  });

  it("does NOT swallow a genuine 22023 mismatch (amount) as terminal-intent — stays 503", async () => {
    const handler = createProviderPaymentWebhookHandler({
      provider: "stripe",
      webhooksEnabled: () => true,
      verifyAndNormalize: vi.fn().mockResolvedValue(stripeSucceededEvent()),
      paymentControlPort: {
        ingestPaymentEvent: vi.fn().mockResolvedValue({
          paymentEventId: "11111111-1111-4111-8111-111111111111",
          paymentIntentId: "22222222-2222-4222-8222-222222222222",
          paymentAttemptId: null,
          replayed: false,
        }),
        applyPaymentResult: vi
          .fn()
          .mockRejectedValue(new Error("rpc: payment_control_result_amount_mismatch (22023)")),
      },
    });
    const res = createResponse();

    await handler({ method: "POST", body: {} } as never, res as never);

    expect(res.statusCode).toBe(503);
  });

  describe("setup-event ledger closure", () => {
    it("marks a setup.succeeded ledger row processed once the full pipeline resolved", async () => {
      const calls: string[] = [];
      const upsertFromWebhook = vi.fn().mockImplementation(async () => {
        calls.push("methodRef");
        return { replayed: false };
      });
      const afterProcessed = vi.fn().mockImplementation(async () => {
        calls.push("afterProcessed");
      });
      const markSetupEventProcessed = vi.fn().mockImplementation(async () => {
        calls.push("markProcessed");
        return { updated: true };
      });
      const handler = createProviderPaymentWebhookHandler({
        provider: "tpay",
        webhooksEnabled: () => true,
        verifyAndNormalize: vi.fn().mockResolvedValue(tpaySetupSucceededEvent()),
        paymentControlPort: {
          ingestPaymentEvent: vi.fn().mockResolvedValue({
            paymentEventId: "11111111-1111-4111-8111-111111111111",
            paymentIntentId: "22222222-2222-4222-8222-222222222222",
            paymentAttemptId: null,
            replayed: false,
          }),
          markSetupEventProcessed,
        },
        methodRefPort: { upsertFromWebhook },
        afterProcessed,
      });
      const res = createResponse();

      await handler({ method: "POST", body: {} } as never, res as never);

      expect(res.statusCode).toBe(200);
      expect(markSetupEventProcessed).toHaveBeenCalledTimes(1);
      expect(markSetupEventProcessed).toHaveBeenCalledWith({
        paymentEventId: "11111111-1111-4111-8111-111111111111",
      });
      // Processed only AFTER every setup mutation resolved.
      expect(calls).toEqual(["methodRef", "afterProcessed", "markProcessed"]);
    });

    it("does NOT mark a money event (payment.succeeded) via the setup closer", async () => {
      const markSetupEventProcessed = vi.fn().mockResolvedValue({ updated: true });
      const handler = createProviderPaymentWebhookHandler({
        provider: "stripe",
        webhooksEnabled: () => true,
        verifyAndNormalize: vi.fn().mockResolvedValue(stripeSucceededEvent()),
        paymentControlPort: {
          ingestPaymentEvent: vi.fn().mockResolvedValue({
            paymentEventId: "11111111-1111-4111-8111-111111111111",
            paymentIntentId: "22222222-2222-4222-8222-222222222222",
            paymentAttemptId: null,
            replayed: false,
          }),
          applyPaymentResult: vi.fn().mockResolvedValue({ replayed: false }),
          markSetupEventProcessed,
        },
      });

      await handler({ method: "POST", body: {} } as never, createResponse() as never);

      expect(markSetupEventProcessed).not.toHaveBeenCalled();
    });

    it("leaves the ledger row untouched when the method-ref upsert throws (retryable 5xx)", async () => {
      const markSetupEventProcessed = vi.fn().mockResolvedValue({ updated: true });
      const handler = createProviderPaymentWebhookHandler({
        provider: "tpay",
        webhooksEnabled: () => true,
        verifyAndNormalize: vi.fn().mockResolvedValue(tpaySetupSucceededEvent()),
        paymentControlPort: {
          ingestPaymentEvent: vi.fn().mockResolvedValue({
            paymentEventId: "11111111-1111-4111-8111-111111111111",
            paymentIntentId: null,
            paymentAttemptId: null,
            replayed: false,
          }),
          markSetupEventProcessed,
        },
        methodRefPort: {
          upsertFromWebhook: vi.fn().mockRejectedValue(new Error("transient upstream failure")),
        },
      });
      const res = createResponse();

      await handler({ method: "POST", body: {} } as never, res as never);

      expect(res.statusCode).toBe(503);
      expect(markSetupEventProcessed).not.toHaveBeenCalled();
    });

    it("leaves the ledger row untouched when afterProcessed activation throws", async () => {
      const markSetupEventProcessed = vi.fn().mockResolvedValue({ updated: true });
      const handler = createProviderPaymentWebhookHandler({
        provider: "tpay",
        webhooksEnabled: () => true,
        verifyAndNormalize: vi.fn().mockResolvedValue(tpaySetupSucceededEvent()),
        paymentControlPort: {
          ingestPaymentEvent: vi.fn().mockResolvedValue({
            paymentEventId: "11111111-1111-4111-8111-111111111111",
            paymentIntentId: null,
            paymentAttemptId: null,
            replayed: false,
          }),
          markSetupEventProcessed,
        },
        afterProcessed: vi.fn().mockRejectedValue(new Error("activation failed")),
      });
      const res = createResponse();

      await handler({ method: "POST", body: {} } as never, res as never);

      expect(res.statusCode).toBe(503);
      expect(markSetupEventProcessed).not.toHaveBeenCalled();
    });

    it("marks on an idempotent replay too, so provider redelivery self-heals stuck rows", async () => {
      const markSetupEventProcessed = vi.fn().mockResolvedValue({ updated: false });
      const handler = createProviderPaymentWebhookHandler({
        provider: "tpay",
        webhooksEnabled: () => true,
        verifyAndNormalize: vi.fn().mockResolvedValue(tpaySetupSucceededEvent()),
        paymentControlPort: {
          ingestPaymentEvent: vi.fn().mockResolvedValue({
            paymentEventId: "11111111-1111-4111-8111-111111111111",
            paymentIntentId: null,
            paymentAttemptId: null,
            replayed: true,
          }),
          markSetupEventProcessed,
        },
      });
      const res = createResponse();

      await handler({ method: "POST", body: {} } as never, res as never);

      expect(res.statusCode).toBe(200);
      expect(markSetupEventProcessed).toHaveBeenCalledTimes(1);
    });

    it("stays compatible with control ports that do not implement the closer", async () => {
      const handler = createProviderPaymentWebhookHandler({
        provider: "tpay",
        webhooksEnabled: () => true,
        verifyAndNormalize: vi.fn().mockResolvedValue(tpaySetupSucceededEvent()),
        paymentControlPort: {
          ingestPaymentEvent: vi.fn().mockResolvedValue({
            paymentEventId: "11111111-1111-4111-8111-111111111111",
            paymentIntentId: null,
            paymentAttemptId: null,
            replayed: false,
          }),
        },
      });
      const res = createResponse();

      await handler({ method: "POST", body: {} } as never, res as never);

      expect(res.statusCode).toBe(200);
    });
  });
});

function stripeSucceededEvent() {
  return {
    provider: "stripe" as const,
    providerEventId: "evt_123",
    eventType: "payment.succeeded" as const,
    providerPaymentId: "pi_123",
    paymentIntentId: "22222222-2222-4222-8222-222222222222",
    amountMinor: 1490,
    currency: "PLN",
    occurredAt: "2026-06-06T12:00:00.000Z",
    rawPayload: { id: "evt_123" },
  };
}

function tpaySetupSucceededEvent() {
  return {
    provider: "tpay" as const,
    providerEventId: "ALIAS_REGISTER:openlup_22222222",
    eventType: "setup.succeeded" as const,
    providerPaymentId: "openlup_22222222",
    occurredAt: "2026-07-24T12:00:00.000Z",
    rawPayload: { eventKind: "blik_alias" },
  };
}

function stripeRefundEvent(refundKind: "full" | "partial") {
  return {
    provider: "stripe" as const,
    providerEventId: refundKind === "full" ? "evt_refund_full" : "evt_refund_partial",
    eventType: "payment.refunded" as const,
    providerPaymentId: "pi_123",
    paymentIntentId: "22222222-2222-4222-8222-222222222222",
    amountMinor: 53640,
    currency: "PLN",
    occurredAt: "2026-06-06T12:00:00.000Z",
    refundKind,
    rawPayload: { id: refundKind === "full" ? "evt_refund_full" : "evt_refund_partial" },
  };
}

function createResponse() {
  return {
    statusCode: 200,
    body: undefined as unknown,
    headers: {} as Record<string, string>,
    setHeader(key: string, value: string) {
      this.headers[key] = value;
      return this;
    },
    status(code: number) {
      this.statusCode = code;
      return this;
    },
    json(body: unknown) {
      this.body = body;
      return this;
    },
  };
}

function readData(body: unknown): unknown {
  if (!body || typeof body !== "object") throw new Error("Missing response body");
  return (body as { data?: unknown }).data;
}
