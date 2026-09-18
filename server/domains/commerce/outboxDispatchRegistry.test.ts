import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  COMMERCE_CHECKOUT_RECOVERY_EVENT_TYPE,
  COMMERCE_CHECKOUT_EXPIRED_EVENT_TYPE,
  COMMERCE_ORDER_CANCELED_EVENT_TYPE,
  COMMERCE_ORDER_DRAFT_CREATED_EVENT_TYPE,
  COMMERCE_ORDER_PAID_EMAIL_EVENT_TYPE,
  COMMERCE_ORDER_PAID_EVENT_TYPE,
  COMMERCE_PAYMENT_FAILED_EVENT_TYPE,
  COMMERCE_ORDER_REFUNDED_EVENT_TYPE,
  COMMERCE_SHIPMENT_DISPATCHED_EVENT_TYPE,
  COMMERCE_SHIPMENT_DELIVERED_EVENT_TYPE,
  COMMERCE_SHIPMENT_EXCEPTION_EVENT_TYPE,
  COMMERCE_RETURN_APPROVED_EVENT_TYPE,
  COMMERCE_RETURN_REJECTED_EVENT_TYPE,
} from "../../../src/domains/commerce/outboxEventContracts.js";
import type {
  OrderPaymentLifecyclePort,
  OrderPaidLinesPort,
  OrderRecipientPort,
  TransactionalEmailPort,
} from "./outboxOrderDraftEmailPorts.js";
import type { OrderPaidFulfillmentPort } from "./outboxOrderPaidFulfillmentPorts.js";
import { claimAllowlist, createOutboxDispatchRegistry } from "./outboxDispatchRegistry.js";

const fulfillmentPort: OrderPaidFulfillmentPort = {
  ensureFulfilledFromPaidOrder: async () => ({ kind: "completed" }),
};

const sendOk = async () => ({
  ok: true as const,
  resendId: "re_fake",
  httpStatus: 200,
  providerError: null,
  aborted: false,
});

const fakes: {
  transactionalEmail: {
    emailPort: TransactionalEmailPort;
    recipientPort: OrderRecipientPort;
    lifecyclePort: OrderPaymentLifecyclePort;
    orderPaidLinesPort: OrderPaidLinesPort;
  };
  fulfillmentPort?: OrderPaidFulfillmentPort;
  fulfillmentEnabled: boolean;
} = {
  transactionalEmail: {
    emailPort: {
      findExistingSend: async () => false,
      sendOrderConfirmation: sendOk,
      sendCheckoutRecovery: sendOk,
      sendOrderPaidConfirmation: sendOk,
      sendPaymentFailedNotice: sendOk,
      sendCheckoutExpiredNotice: sendOk,
      sendOrderCanceledNotice: sendOk,
      sendOrderRefundedNotice: sendOk,
      sendShipmentDispatchedNotice: sendOk,
      sendShipmentDeliveredNotice: sendOk,
      sendShipmentExceptionNotice: sendOk,
      sendReturnApprovedNotice: sendOk,
      sendReturnRejectedNotice: sendOk,
    },
    recipientPort: {
      resolve: async () => null,
    },
    lifecyclePort: {
      read: async () => ({ orderStatus: "draft", paymentStatus: null, hasPayment: false }),
    },
    orderPaidLinesPort: {
      read: async () => null,
    },
  },
  fulfillmentPort,
  fulfillmentEnabled: false,
};

const EXPECTED_EVENT_TYPES = [
  COMMERCE_CHECKOUT_RECOVERY_EVENT_TYPE,
  COMMERCE_ORDER_DRAFT_CREATED_EVENT_TYPE,
  COMMERCE_ORDER_PAID_EMAIL_EVENT_TYPE,
  COMMERCE_PAYMENT_FAILED_EVENT_TYPE,
  COMMERCE_CHECKOUT_EXPIRED_EVENT_TYPE,
  COMMERCE_ORDER_REFUNDED_EVENT_TYPE,
  COMMERCE_SHIPMENT_DISPATCHED_EVENT_TYPE,
  COMMERCE_SHIPMENT_DELIVERED_EVENT_TYPE,
  COMMERCE_SHIPMENT_EXCEPTION_EVENT_TYPE,
  COMMERCE_RETURN_APPROVED_EVENT_TYPE,
  COMMERCE_RETURN_REJECTED_EVENT_TYPE,
].sort();

describe("outboxDispatchRegistry", () => {
  // CI tripwire for the don't-claim constraint: only the event types whose
  // handlers register this wave are claimable; the remaining PSP-blocked types
  // stay structurally unclaimable until their handlers register.
  it("registers only runtime-ready commerce handlers by default", () => {
    const registry = createOutboxDispatchRegistry(fakes);
    expect([...registry.keys()].sort()).toEqual(EXPECTED_EVENT_TYPES);
    expect(registry.get(COMMERCE_ORDER_PAID_EMAIL_EVENT_TYPE)?.eventType).toBe(
      COMMERCE_ORDER_PAID_EMAIL_EVENT_TYPE,
    );
    expect(registry.get(COMMERCE_ORDER_PAID_EVENT_TYPE)).toBeUndefined();
  });

  it("registers commerce.order.paid only when fulfillment runtime is enabled", () => {
    const registry = createOutboxDispatchRegistry({ ...fakes, fulfillmentEnabled: true, fulfillmentPort });
    expect(registry.get(COMMERCE_ORDER_PAID_EVENT_TYPE)?.eventType).toBe(COMMERCE_ORDER_PAID_EVENT_TYPE);
    expect([...registry.keys()].sort()).toEqual([...EXPECTED_EVENT_TYPES, COMMERCE_ORDER_PAID_EVENT_TYPE].sort());
  });

  it("can register fulfillment without transactional email runtime", () => {
    const registry = createOutboxDispatchRegistry({ fulfillmentEnabled: true, fulfillmentPort });
    expect([...registry.keys()]).toEqual([COMMERCE_ORDER_PAID_EVENT_TYPE]);
  });

  it("derives the claim allowlist from the registry keys", () => {
    const registry = createOutboxDispatchRegistry(fakes);
    expect(claimAllowlist(registry).sort()).toEqual(EXPECTED_EVENT_TYPES);
  });

  it("keeps the dormant cancellation email unregistered", () => {
    const registry = createOutboxDispatchRegistry(fakes);

    expect(registry.get(COMMERCE_ORDER_CANCELED_EVENT_TYPE)).toBeUndefined();
  });

  it("appends cross-domain extraHandlers after the commerce handlers", () => {
    const extra = {
      eventType: "subscription.cancelled",
      timeoutMs: 1000,
      handle: async () => ({ kind: "processed" as const }),
    };
    const registry = createOutboxDispatchRegistry({ ...fakes, extraHandlers: [extra] });
    expect(registry.get("subscription.cancelled")).toBe(extra);
    expect([...registry.keys()].sort()).toEqual([...EXPECTED_EVENT_TYPES, "subscription.cancelled"].sort());
  });

  it("composes duplicate handler event types in registration order", async () => {
    const first = vi.fn(async () => ({ kind: "processed" as const, detail: { first: true } }));
    const second = vi.fn(async () => ({ kind: "processed" as const, detail: { second: true } }));
    const duplicate = {
      eventType: COMMERCE_ORDER_DRAFT_CREATED_EVENT_TYPE,
      timeoutMs: 1000,
      handle: second,
    };
    const registry = createOutboxDispatchRegistry({
      ...fakes,
      transactionalEmail: undefined,
      extraHandlers: [
        { eventType: COMMERCE_ORDER_DRAFT_CREATED_EVENT_TYPE, timeoutMs: 1000, handle: first },
        duplicate,
      ],
    });

    await expect(registry.get(COMMERCE_ORDER_DRAFT_CREATED_EVENT_TYPE)?.handle({
      id: "evt-1",
      created_at: "",
      available_at: "",
      processed_at: null,
      aggregate_type: "commerce_order",
      aggregate_id: "order-1",
      event_type: COMMERCE_ORDER_DRAFT_CREATED_EVENT_TYPE,
      idempotency_key: "key-1",
      status: "processing",
      attempts: 1,
      payload: {},
      error: null,
      metadata: {},
    }, new AbortController().signal)).resolves.toMatchObject({
      kind: "processed",
      detail: { first: { first: true }, second: { second: true } },
    });
    expect(first.mock.invocationCallOrder[0]).toBeLessThan(second.mock.invocationCallOrder[0] ?? 0);
  });

  it("hoists the email handler's delivery-lifecycle keys to top-level metadata when composing (so the DB lifecycle-repair trigger can see resendId)", async () => {
    // Regression: commerce.order.canceled = email + accounting-reversal. The email
    // outcome's resendId was nested under `first`, so the SQL trigger's top-level
    // `metadata->>'resendId'` lookup missed it and clobbered a sent delivery to
    // `skipped`/`processed_without_provider_send`.
    const emailHandler = vi.fn(async () => ({ kind: "processed" as const, detail: { resendId: "re_123" } }));
    const reversalHandler = vi.fn(async () => ({
      kind: "processed" as const,
      detail: { invoiceStatus: "no_invoice", accountingReversalAction: "no_invoice" },
    }));
    const registry = createOutboxDispatchRegistry({
      ...fakes,
      transactionalEmail: undefined,
      extraHandlers: [
        { eventType: COMMERCE_ORDER_DRAFT_CREATED_EVENT_TYPE, timeoutMs: 1000, handle: emailHandler },
        { eventType: COMMERCE_ORDER_DRAFT_CREATED_EVENT_TYPE, timeoutMs: 1000, handle: reversalHandler },
      ],
    });

    const outcome = await registry.get(COMMERCE_ORDER_DRAFT_CREATED_EVENT_TYPE)?.handle({
      id: "evt-1",
      created_at: "",
      available_at: "",
      processed_at: null,
      aggregate_type: "commerce_order",
      aggregate_id: "order-1",
      event_type: COMMERCE_ORDER_DRAFT_CREATED_EVENT_TYPE,
      idempotency_key: "key-1",
      status: "processing",
      attempts: 1,
      payload: {},
      error: null,
      metadata: {},
    }, new AbortController().signal);

    expect(outcome).toMatchObject({
      kind: "processed",
      detail: {
        resendId: "re_123",
        first: { resendId: "re_123" },
        second: { invoiceStatus: "no_invoice", accountingReversalAction: "no_invoice" },
      },
    });
  });
});

describe("outboxDispatchRegistry channel buyer-comms suppression (wave B6)", () => {
  const ORDER_UUID = "11111111-2222-3333-4444-555555555555";

  const rowFor = (eventType: string, metadata: Record<string, unknown> = {}) => ({
    id: "evt-b6",
    created_at: "",
    available_at: "",
    processed_at: null,
    aggregate_type: "commerce_order",
    aggregate_id: ORDER_UUID,
    event_type: eventType,
    idempotency_key: `key:${ORDER_UUID}`,
    status: "processing",
    attempts: 1,
    payload: { orderUuid: ORDER_UUID, orderId: `order_${ORDER_UUID}` },
    error: null,
    metadata,
  });

  const readerFor = (buyerCommsOwner: string | null) => ({
    readOrderBuyerCommsPolicy: vi.fn(async () =>
      buyerCommsOwner === null ? null : { sourceKind: "marketplace", buyerCommsOwner }),
  });

  // Enumerated from the registry itself, not from a doc: exactly the
  // buyer-facing set the transactionalEmail block composes.
  const SUPPRESSED_EVENT_TYPES = [
    COMMERCE_ORDER_PAID_EMAIL_EVENT_TYPE,
    COMMERCE_ORDER_REFUNDED_EVENT_TYPE,
    COMMERCE_SHIPMENT_DISPATCHED_EVENT_TYPE,
    COMMERCE_SHIPMENT_DELIVERED_EVENT_TYPE,
    COMMERCE_SHIPMENT_EXCEPTION_EVENT_TYPE,
    COMMERCE_RETURN_APPROVED_EVENT_TYPE,
    COMMERCE_RETURN_REJECTED_EVENT_TYPE,
  ];

  // The structurally-unreachable four. They are NOT wrapped, so the reader must
  // never be consulted for them; this pins the enumeration in both directions.
  const UNWRAPPED_EVENT_TYPES = [
    COMMERCE_ORDER_DRAFT_CREATED_EVENT_TYPE,
    COMMERCE_CHECKOUT_RECOVERY_EVENT_TYPE,
    COMMERCE_PAYMENT_FAILED_EVENT_TYPE,
    COMMERCE_CHECKOUT_EXPIRED_EVENT_TYPE,
  ];

  it.each(SUPPRESSED_EVENT_TYPES)("skips %s when the channel owns buyer comms", async (eventType) => {
    const reader = readerFor("channel");
    const registry = createOutboxDispatchRegistry({
      ...fakes,
      transactionalEmail: { ...fakes.transactionalEmail, buyerCommsPolicyReader: reader },
    });

    await expect(
      registry.get(eventType)?.handle(rowFor(eventType), new AbortController().signal),
    ).resolves.toEqual({ kind: "processed", detail: { skipped: "channel_owns_buyer_comms" } });
    expect(reader.readOrderBuyerCommsPolicy).toHaveBeenCalledWith(ORDER_UUID);
  });

  it.each(SUPPRESSED_EVENT_TYPES)("leaves %s untouched for a platform-owned order", async (eventType) => {
    const reader = readerFor("platform");
    const registry = createOutboxDispatchRegistry({
      ...fakes,
      transactionalEmail: { ...fakes.transactionalEmail, buyerCommsPolicyReader: reader },
    });

    // The shared recipientPort fake resolves null, so the storefront path lands
    // on the handler's OWN skip reason. That is the regression proof: the wrapper
    // delegated instead of deciding.
    await expect(
      registry.get(eventType)?.handle(rowFor(eventType), new AbortController().signal),
    ).resolves.toMatchObject({ kind: "processed" });
    const outcome = await registry.get(eventType)!.handle(rowFor(eventType), new AbortController().signal);
    expect((outcome as { detail?: { skipped?: string } }).detail?.skipped)
      .not.toBe("channel_owns_buyer_comms");
  });

  it("leaves a storefront order (no channel row) untouched", async () => {
    const reader = readerFor(null);
    const registry = createOutboxDispatchRegistry({
      ...fakes,
      transactionalEmail: { ...fakes.transactionalEmail, buyerCommsPolicyReader: reader },
    });

    const outcome = await registry.get(COMMERCE_ORDER_PAID_EMAIL_EVENT_TYPE)!
      .handle(rowFor(COMMERCE_ORDER_PAID_EMAIL_EVENT_TYPE), new AbortController().signal);
    expect((outcome as { detail?: { skipped?: string } }).detail?.skipped)
      .not.toBe("channel_owns_buyer_comms");
  });

  it("suppresses the RECONCILER-BACKFILLED paid email, which is the bug trigger-level suppression would ship", async () => {
    // commerce_reconcile_checkout_email_outbox re-inserts commerce.order.paid.email
    // for every paid order missing one, keyed only on the order id, and
    // outboxDispatchRuntime runs it inline immediately before the worker. This
    // row is that insert, verbatim: same event type, same idempotency key shape,
    // same synthesised payload, and the reconciler's own metadata source stamp.
    const reader = readerFor("channel");
    const registry = createOutboxDispatchRegistry({
      ...fakes,
      transactionalEmail: { ...fakes.transactionalEmail, buyerCommsPolicyReader: reader },
    });
    const backfilled = {
      ...rowFor(COMMERCE_ORDER_PAID_EMAIL_EVENT_TYPE, {
        source: "commerce_reconcile_checkout_email_outbox",
      }),
      idempotency_key: `order_paid_email:${ORDER_UUID}`,
      attempts: 0,
    };

    await expect(
      registry.get(COMMERCE_ORDER_PAID_EMAIL_EVENT_TYPE)?.handle(backfilled, new AbortController().signal),
    ).resolves.toEqual({ kind: "processed", detail: { skipped: "channel_owns_buyer_comms" } });
  });

  it.each(UNWRAPPED_EVENT_TYPES)("never consults the policy for %s", async (eventType) => {
    const reader = readerFor("channel");
    const registry = createOutboxDispatchRegistry({
      ...fakes,
      transactionalEmail: { ...fakes.transactionalEmail, buyerCommsPolicyReader: reader },
    });

    await registry.get(eventType)?.handle(rowFor(eventType), new AbortController().signal);
    expect(reader.readOrderBuyerCommsPolicy).not.toHaveBeenCalled();
  });

  it("delegates a payload with no order uuid rather than inventing a second failure mode", async () => {
    const reader = readerFor("channel");
    const registry = createOutboxDispatchRegistry({
      ...fakes,
      transactionalEmail: { ...fakes.transactionalEmail, buyerCommsPolicyReader: reader },
    });
    const malformed = { ...rowFor(COMMERCE_ORDER_PAID_EMAIL_EVENT_TYPE), payload: {} };

    await expect(
      registry.get(COMMERCE_ORDER_PAID_EMAIL_EVENT_TYPE)?.handle(malformed, new AbortController().signal),
    ).resolves.toMatchObject({ kind: "discard" });
    expect(reader.readOrderBuyerCommsPolicy).not.toHaveBeenCalled();
  });

  it("keeps today's behaviour when no reader is composed", async () => {
    const registry = createOutboxDispatchRegistry(fakes);
    const outcome = await registry.get(COMMERCE_ORDER_PAID_EMAIL_EVENT_TYPE)!
      .handle(rowFor(COMMERCE_ORDER_PAID_EMAIL_EVENT_TYPE), new AbortController().signal);
    expect((outcome as { detail?: { skipped?: string } }).detail?.skipped)
      .not.toBe("channel_owns_buyer_comms");
  });
});

describe("outboxDispatchContracts purity", () => {
  // vitest runs from the repo root (guardrail-test precedent).
  const contractsPath = join(
    process.cwd(),
    "server/domains/commerce/outboxDispatchContracts.ts",
  );
  const rawSource = readFileSync(contractsPath, "utf8");
  // The header comment legitimately documents "no process.env reads"; the
  // tripwire targets code, so comments are stripped before the regex runs.
  const codeOnly = rawSource
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/\/\/.*$/gm, "");

  it("contains no IO, client, scheduler, payment, or env access in code", () => {
    expect(codeOnly).not.toMatch(
      /createClient|\.rpc\s*\(|\.from\s*\(|\.storage|functions\s*\.\s*invoke|stripe|payment_intent|setInterval|setTimeout|process\.env/i,
    );
  });

  it("contains no event-type string literal (registry stays the single source)", () => {
    expect(rawSource).not.toContain("commerce.order_draft");
  });
});
