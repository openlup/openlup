import { describe, expect, it, vi } from "vitest";
import { addAdminCommerceOrderNote, createAdminCommerceOrderHold, executeAdminPaidFulfillmentRecovery, getAdminCommerceOrderDetail, getAdminCommerceOrders, getAdminCommerceRenewalExceptions, markAdminCommerceOrderRefundedManual, previewAdminPaidFulfillmentRecovery, releaseAdminCommerceOrderHold, updateAdminCommerceOrderShippingAddress } from "./omsClient";
import {
  detailResponse,
  holdResponse,
  listResponse,
  markRefundedResponse,
  noteResponse,
  updateAddressResponse,
} from "./omsClient.fixtures";

describe("commerce OMS BFF client", () => {
  it("reads hidden admin commerce order list with bearer auth", async () => {
    const fetcher = createFetcher(listResponse());

    await expect(
      getAdminCommerceOrders(
        "token",
        {
          page: 1,
          pageSize: 25,
          attentionOnly: true,
          nextAction: "create_fulfillment",
          sort: "attention_priority_desc",
          search: "jan@example.com",
        },
        { fetcher },
      ),
    ).resolves.toMatchObject({
      orders: [{ paymentStatus: "succeeded" }],
    });

    expect(fetcher).toHaveBeenCalledWith(
      "/api/bff/admin/commerce/orders",
      expect.objectContaining({ method: "POST" }),
    );
    expect(fetcher.mock.calls[0][0]).not.toContain("jan@example.com");
    expect(readJsonBody(fetcher)).toMatchObject({
      page: 1,
      pageSize: 25,
      attentionOnly: true,
      nextAction: "create_fulfillment",
      sort: "attention_priority_desc",
      search: "jan@example.com",
    });
    expect(readAuth(fetcher)).toBe("Bearer token");
  });

  it("reads hidden admin commerce order detail", async () => {
    const fetcher = createFetcher(detailResponse());

    await expect(
      getAdminCommerceOrderDetail("token", "42222222-2222-4222-8222-222222222221", { fetcher }),
    ).resolves.toMatchObject({
      order: { fulfillmentEligibility: { allowed: true } },
    });
  });

  it("reads renewal exception projection with POST body filters", async () => {
    const fetcher = createFetcher(renewalExceptionsResponse());

    await expect(
      getAdminCommerceRenewalExceptions("token", { page: 2, pageSize: 10 }, { fetcher }),
    ).resolves.toMatchObject({
      exceptions: [{ kind: "prepared_without_provider_ack" }],
    });

    expect(fetcher).toHaveBeenCalledWith(
      "/api/bff/admin/commerce/renewal-exceptions",
      expect.objectContaining({ method: "POST" }),
    );
    expect(readJsonBody(fetcher)).toMatchObject({ page: 2, pageSize: 10 });
    expect(readAuth(fetcher)).toBe("Bearer token");
  });

  it("previews and executes paid-fulfillment recovery through the typed OMS client", async () => {
    const previewFetcher = createFetcher({
      contractVersion: "commerce.v0",
      checkedOrders: 1,
      candidates: [recoveryCandidate()],
    });

    await expect(previewAdminPaidFulfillmentRecovery("token", {
      operation: "preview",
      orderIds: ["42222222-2222-4222-8222-222222222221"],
      minimumAgeSeconds: 60,
      limit: 10,
    }, { fetcher: previewFetcher })).resolves.toMatchObject({
      candidates: [{ recommendedAction: "requeue_discarded_order_paid_outbox" }],
    });

    expect(previewFetcher).toHaveBeenCalledWith(
      "/api/bff/admin/commerce/paid-fulfillment-recovery",
      expect.objectContaining({ method: "POST" }),
    );
    expect(readJsonBody(previewFetcher)).toMatchObject({
      operation: "preview",
      orderIds: ["42222222-2222-4222-8222-222222222221"],
    });

    const executeFetcher = createFetcher({
      contractVersion: "commerce.v0",
      action: "requeue_discarded_order_paid_outbox",
      requeuedCount: 1,
      eventIds: ["52222222-2222-4222-8222-222222222221"],
    });

    await expect(executeAdminPaidFulfillmentRecovery("token", {
      operation: "execute",
      action: "requeue_discarded_order_paid_outbox",
      eventIds: ["52222222-2222-4222-8222-222222222221"],
      orderIds: ["42222222-2222-4222-8222-222222222221"],
      reason: "operator confirmed local discarded order-paid event",
      minimumAgeSeconds: 60,
    }, { fetcher: executeFetcher })).resolves.toMatchObject({ requeuedCount: 1 });

    expect(readJsonBody(executeFetcher)).toMatchObject({
      operation: "execute",
      action: "requeue_discarded_order_paid_outbox",
      eventIds: ["52222222-2222-4222-8222-222222222221"],
    });
  });

  it("calls disabled-by-default hold mutation endpoints through typed clients", async () => {
    const fetcher = createFetcher(holdResponse());
    const holdRequest = {
      idempotencyKey: "oms-hold-1",
      orderId: "42222222-2222-4222-8222-222222222221",
      reason: "manual_support" as const,
    };

    await expect(createAdminCommerceOrderHold("token", holdRequest, { fetcher })).resolves.toMatchObject({
      hold: { status: "active" },
    });
    await expect(
      releaseAdminCommerceOrderHold(
        "token",
        { idempotencyKey: "oms-release-1", holdId: "92222222-2222-4222-8222-222222222221" },
        { fetcher },
      ),
    ).resolves.toMatchObject({ hold: { status: "active" } });
  });

  it("posts support notes through the typed OMS client", async () => {
    const fetcher = createFetcher(noteResponse());

    await expect(
      addAdminCommerceOrderNote(
        "token",
        {
          idempotencyKey: "oms-note-1",
          orderId: "42222222-2222-4222-8222-222222222221",
          note: "Checked address",
        },
        { fetcher },
      ),
    ).resolves.toMatchObject({ operation: { type: "support_note" } });

    expect(fetcher).toHaveBeenCalledWith(
      "/api/bff/admin/commerce/orders/note",
      expect.objectContaining({ method: "POST" }),
    );
  });

  it("posts manual mark-refunded requests through the typed OMS client", async () => {
    const fetcher = createFetcher(markRefundedResponse());

    await expect(
      markAdminCommerceOrderRefundedManual(
        "token",
        {
          idempotencyKey: "oms-mark-refunded-1", // gitleaks:allow
          orderId: "42222222-2222-4222-8222-222222222221",
          reason: "operator confirmed Tpay panel refund",
        },
        { fetcher },
      ),
    ).resolves.toMatchObject({ status: "refunded", replayed: false });

    expect(fetcher).toHaveBeenCalledWith(
      "/api/bff/admin/commerce/orders/mark-refunded",
      expect.objectContaining({ method: "POST" }),
    );
  });

  it("posts shipping address corrections through the typed OMS client", async () => {
    const fetcher = createFetcher(updateAddressResponse());

    await expect(
      updateAdminCommerceOrderShippingAddress(
        "token",
        {
          idempotencyKey: "oms-address-1",
          orderId: "42222222-2222-4222-8222-222222222221",
          expectedRevision: 1,
          expectedContactDigest: "0123456789abcdef0123456789abcdef",
          address: {
            recipientName: "Ala Kowalska",
            contactEmail: "ala@example.com",
            contactPhone: "500600700",
            line1: "Prosta 1",
            city: "Warszawa",
            postalCode: "00-001",
            country: "PL",
          },
        },
        { fetcher },
      ),
    ).resolves.toMatchObject({ operation: { type: "shipping_address_updated" } });

    expect(fetcher).toHaveBeenCalledWith(
      "/api/bff/admin/commerce/orders/update-shipping-address",
      expect.objectContaining({ method: "POST" }),
    );
  });

  it("throws on BFF errors and malformed envelopes", async () => {
    await expect(
      getAdminCommerceOrders("token", { page: 1, pageSize: 25 }, {
        fetcher: createRawFetcher({ ok: false, error: { code: "FORBIDDEN", message: "Admin role required" } }),
      }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });

    await expect(
      getAdminCommerceOrders("token", { page: 1, pageSize: 25 }, {
        fetcher: createRawFetcher({ ok: true, data: { orders: [{}] } }),
      }),
    ).rejects.toMatchObject({ code: "INVALID_RESPONSE" });
  });
});

function createFetcher(data: unknown) {
  return createRawFetcher({ ok: true, data });
}

function createRawFetcher(payload: unknown) {
  return vi.fn().mockResolvedValue({
    ok: true,
    json: async () => payload,
  });
}

function readAuth(fetcher: ReturnType<typeof createRawFetcher>) {
  const init = fetcher.mock.calls[0]?.[1] as RequestInit;
  return new Headers(init.headers).get("Authorization");
}

function readJsonBody(fetcher: ReturnType<typeof createRawFetcher>) {
  const init = fetcher.mock.calls[0]?.[1] as RequestInit;
  return JSON.parse(String(init.body));
}

function recoveryCandidate() {
  return {
    orderId: "42222222-2222-4222-8222-222222222221",
    orderStatus: "paid",
    orderMode: "one_time",
    fulfillmentOrderId: null,
    providerKind: null,
    outboxEventId: "52222222-2222-4222-8222-222222222221",
    outboxStatus: "discarded",
    outboxAttempts: 5,
    reason: "order_paid_outbox_discarded",
    recommendedAction: "requeue_discarded_order_paid_outbox",
    recoveryPosture: "automatic_local_requeue_safe",
    ageSeconds: 7200,
  };
}

function renewalExceptionsResponse() {
  return {
    contractVersion: "commerce.v0",
    checkedAt: "2026-07-03T12:00:00.000Z",
    exceptions: [{
      dedupeKey: "renewal-exception:prepared_without_provider_ack:sub:cycle:intent:attempt",
      kind: "prepared_without_provider_ack",
      severity: "p1",
      owner: "commerce/payment",
      customerSafeStatus: "operator_review_required",
      operatorNextAction: "inspect_provider_before_retry",
      reason: "prepared_subscription_attempt_without_provider_ack",
      subscriptionId: "sub-1",
      subscriptionCycleId: "cycle-1",
      orderId: null,
      paymentIntentId: "intent-1",
      paymentAttemptId: "attempt-1",
      provider: "stripe",
      ageSeconds: 1900,
      observedAt: "2026-07-03T12:00:00.000Z",
      orderDetailPath: null,
      triageContext: {
        localPaymentStatus: "processing",
        subscriptionCycleStatus: null,
        orderStatus: null,
        outboxStatus: null,
        outboxAvailableAt: null,
        outboxAttempts: null,
        fulfillmentEligibilityReason: "payment_provider_ack_missing",
        fulfillmentRecoveryPosture: "not_retryable",
        lockedCycleSummary: null,
        futureTemplateSummary: null,
      },
    }],
    summarySignals: [],
    summaryCounts: {
      totalRows: 1,
      preparedWithoutProviderAck: 1,
      paidRenewalWithoutFulfillment: 0,
      dueCycleWithoutOrder: 0,
      paymentRows: 1,
      fulfillmentRows: 0,
      p0: 0,
      p1: 1,
      p2: 0,
      p3: 0,
    },
    totalCount: 1,
    page: 2,
    pageSize: 10,
  };
}
