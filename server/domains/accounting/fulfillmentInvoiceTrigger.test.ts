import { describe, expect, it, vi } from "vitest";
import {
  withAccountingInvoiceShadowTrigger,
  withAutoDispatchAccountingInvoiceTrigger,
  type AutoDispatchFulfillmentResult,
} from "./fulfillmentInvoiceTrigger.js";

describe("fulfillment accounting invoice trigger", () => {
  it("enqueues invoice shadow request after fulfillment handoff", async () => {
    const fulfillmentPort = {
      handOffCommerceFulfillmentOrder: vi.fn(async (_request: { idempotencyKey: string; fulfillmentOrderId: string; actorUserId: string }) => ({
        contractVersion: "commerce.fulfillment.v0",
        fulfillmentOrderId: "11111111-1111-4111-8111-111111111111",
        orderId: "22222222-2222-4222-8222-222222222222",
        status: "handed_over",
        replayed: false,
      })),
    };
    const accountingPort = {
      requestInvoiceIssueFromFulfillmentHandoff: vi.fn(async () => ({
        invoice: {
          id: "33333333-3333-4333-8333-333333333333",
          invoiceRef: "order_1:base",
          status: "issue_requested",
          replayed: false,
        },
      })),
      requestInvoiceIssueFromPaidOrder: vi.fn(),
    };

    const wrapped = withAccountingInvoiceShadowTrigger(fulfillmentPort, {
      accountingPort,
    });

    await expect(wrapped.handOffCommerceFulfillmentOrder({
      idempotencyKey: "handoff-1",
      fulfillmentOrderId: "11111111-1111-4111-8111-111111111111",
      actorUserId: "44444444-4444-4444-8444-444444444444",
    })).resolves.toMatchObject({ status: "handed_over" });

    expect(accountingPort.requestInvoiceIssueFromFulfillmentHandoff).toHaveBeenCalledWith({
      idempotencyKey: "handoff-1:accounting-invoice",
      fulfillmentOrderId: "11111111-1111-4111-8111-111111111111",
      providerKind: "fakturownia",
    });
  });

  it("does not break fulfillment response when shadow accounting enqueue fails by default", async () => {
    const wrapped = withAccountingInvoiceShadowTrigger({
      handOffCommerceFulfillmentOrder: vi.fn(async (_request: { idempotencyKey: string; fulfillmentOrderId: string; actorUserId: string }) => ({
        contractVersion: "commerce.fulfillment.v0",
        fulfillmentOrderId: "11111111-1111-4111-8111-111111111111",
        orderId: "22222222-2222-4222-8222-222222222222",
        status: "handed_over",
        replayed: false,
      })),
    }, {
      accountingPort: {
        requestInvoiceIssueFromFulfillmentHandoff: vi.fn(async () => {
          throw new Error("db unavailable");
        }),
        requestInvoiceIssueFromPaidOrder: vi.fn(),
      },
    });

    await expect(wrapped.handOffCommerceFulfillmentOrder({
      idempotencyKey: "handoff-1",
      fulfillmentOrderId: "11111111-1111-4111-8111-111111111111",
      actorUserId: "44444444-4444-4444-8444-444444444444",
    })).resolves.toMatchObject({ status: "handed_over" });
  });
});

describe("auto-dispatch accounting invoice trigger", () => {
  const ORDER_UUID = "55555555-5555-4555-8555-555555555555";
  const FULFILLMENT_ID = "66666666-6666-4666-8666-666666666666";
  const signal = new AbortController().signal;

  function portReturning(result: AutoDispatchFulfillmentResult) {
    return { ensureFulfilledFromPaidOrder: vi.fn(async () => result) };
  }
  function accountingStub() {
    return {
      requestInvoiceIssueFromFulfillmentHandoff: vi.fn(async () => ({
        invoice: { id: "inv-1", invoiceRef: "ORDER-1:base", status: "issue_requested", replayed: false },
      })),
      requestInvoiceIssueFromPaidOrder: vi.fn(async () => ({
        invoice: { id: "inv-1", invoiceRef: "ORDER-1:base", status: "issue_requested", replayed: false },
      })),
    };
  }

  it("requests invoice issuance after an auto-dispatched order reaches handed_over", async () => {
    const fulfillmentPort = portReturning({
      kind: "completed",
      detail: { fulfillmentOrderId: FULFILLMENT_ID, status: "handed_over" },
    });
    const accountingPort = accountingStub();

    const wrapped = withAutoDispatchAccountingInvoiceTrigger(fulfillmentPort, {
      accountingPort,
      providerKind: "fakturownia",
    });

    await expect(
      wrapped.ensureFulfilledFromPaidOrder({ orderUuid: ORDER_UUID, outboxEventId: "evt-1", signal }),
    ).resolves.toMatchObject({ kind: "completed" });

    expect(accountingPort.requestInvoiceIssueFromFulfillmentHandoff).toHaveBeenCalledWith({
      idempotencyKey: `order-paid-dispatch:${ORDER_UUID}:accounting-invoice`,
      fulfillmentOrderId: FULFILLMENT_ID,
      providerKind: "fakturownia",
    });
  });

  it("requests invoice issuance from paid order before fulfillment when paid trigger is enabled", async () => {
    const fulfillmentPort = portReturning({
      kind: "completed",
      detail: { fulfillmentOrderId: FULFILLMENT_ID, status: "handed_over" },
    });
    const accountingPort = accountingStub();

    const wrapped = withAutoDispatchAccountingInvoiceTrigger(fulfillmentPort, {
      accountingPort,
      providerKind: "fakturownia",
      issueTrigger: "paid",
    });

    await wrapped.ensureFulfilledFromPaidOrder({ orderUuid: ORDER_UUID, outboxEventId: "evt-1", signal });

    expect(accountingPort.requestInvoiceIssueFromPaidOrder).toHaveBeenCalledWith({
      idempotencyKey: `order-paid-dispatch:${ORDER_UUID}:accounting-invoice-paid`,
      orderId: ORDER_UUID,
      providerKind: "fakturownia",
    });
    expect(accountingPort.requestInvoiceIssueFromFulfillmentHandoff).not.toHaveBeenCalled();
  });

  it("does not request issuance when fulfillment is retryable or fatal", async () => {
    for (const result of [
      { kind: "retryable", reason: "outbox_handler_timeout" },
      { kind: "fatal", reason: "fulfillment_create_missing_id" },
    ] as const) {
      const fulfillmentPort = portReturning(result);
      const accountingPort = accountingStub();
      const wrapped = withAutoDispatchAccountingInvoiceTrigger(fulfillmentPort, { accountingPort });

      await wrapped.ensureFulfilledFromPaidOrder({ orderUuid: ORDER_UUID, outboxEventId: "evt-1", signal });

      expect(accountingPort.requestInvoiceIssueFromFulfillmentHandoff).not.toHaveBeenCalled();
    }
  });

  it("does not break fulfillment when the accounting enqueue fails by default", async () => {
    const fulfillmentPort = portReturning({
      kind: "completed",
      detail: { fulfillmentOrderId: FULFILLMENT_ID, status: "handed_over" },
    });
    const wrapped = withAutoDispatchAccountingInvoiceTrigger(fulfillmentPort, {
      accountingPort: {
        requestInvoiceIssueFromFulfillmentHandoff: vi.fn(async () => {
          throw new Error("db unavailable");
        }),
        requestInvoiceIssueFromPaidOrder: vi.fn(),
      },
    });

    await expect(
      wrapped.ensureFulfilledFromPaidOrder({ orderUuid: ORDER_UUID, outboxEventId: "evt-1", signal }),
    ).resolves.toMatchObject({ kind: "completed", detail: { status: "handed_over" } });
  });

  it("propagates accounting errors when failOnAccountingError is set", async () => {
    const fulfillmentPort = portReturning({
      kind: "completed",
      detail: { fulfillmentOrderId: FULFILLMENT_ID, status: "handed_over" },
    });
    const wrapped = withAutoDispatchAccountingInvoiceTrigger(fulfillmentPort, {
      accountingPort: {
        requestInvoiceIssueFromFulfillmentHandoff: vi.fn(async () => {
          throw new Error("db unavailable");
        }),
        requestInvoiceIssueFromPaidOrder: vi.fn(),
      },
      failOnAccountingError: true,
    });

    await expect(
      wrapped.ensureFulfilledFromPaidOrder({ orderUuid: ORDER_UUID, outboxEventId: "evt-1", signal }),
    ).rejects.toThrow("db unavailable");
  });
});

describe("channel invoice policy at the fulfillment triggers (wave B6)", () => {
  const FULFILLMENT_ORDER_ID = "11111111-1111-4111-8111-111111111111";
  const ORDER_UUID = "22222222-2222-4222-8222-222222222222";

  const readerFor = (invoicePolicy: string | null) => ({
    readOrderInvoicePolicy: vi.fn(async () =>
      invoicePolicy === null ? null : { sourceKind: "marketplace", invoicePolicy }),
  });

  const accountingSpy = () => ({
    requestInvoiceIssueFromFulfillmentHandoff: vi.fn(async () => ({
      invoice: { id: "inv-1", invoiceRef: "ref", status: "issue_requested", replayed: false },
    })),
    requestInvoiceIssueFromPaidOrder: vi.fn(async () => ({
      invoice: { id: "inv-1", invoiceRef: "ref", status: "issue_requested", replayed: false },
    })),
  });

  const handoffPort = () => ({
    handOffCommerceFulfillmentOrder: vi.fn(
      async (_request: { idempotencyKey: string; fulfillmentOrderId: string; actorUserId: string }) =>
        ({ status: "handed_over" }),
    ),
  });

  const paidPort = () => ({
    ensureFulfilledFromPaidOrder: vi.fn(
      async (_input: { orderUuid: string; outboxEventId: string; signal: AbortSignal }):
        Promise<AutoDispatchFulfillmentResult> => ({
          kind: "completed",
          detail: { fulfillmentOrderId: FULFILLMENT_ORDER_ID },
        }),
    ),
  });

  it.each([
    ["issue", true],
    ["suppress", false],
    ["channel_issues", false],
  ] as const)("operator hand-off with policy %s requests=%s", async (invoicePolicy, requested) => {
    const accountingPort = accountingSpy();
    const reader = readerFor(invoicePolicy);
    const wrapped = withAccountingInvoiceShadowTrigger(handoffPort(), {
      accountingPort, invoicePolicyReader: reader,
    });

    await wrapped.handOffCommerceFulfillmentOrder({
      idempotencyKey: "handoff-1", fulfillmentOrderId: FULFILLMENT_ORDER_ID, actorUserId: "actor",
    });

    expect(accountingPort.requestInvoiceIssueFromFulfillmentHandoff)
      .toHaveBeenCalledTimes(requested ? 1 : 0);
    expect(reader.readOrderInvoicePolicy)
      .toHaveBeenCalledWith({ by: "fulfillmentOrder", fulfillmentOrderId: FULFILLMENT_ORDER_ID });
  });

  it("operator hand-off of a STOREFRONT order is unchanged", async () => {
    const accountingPort = accountingSpy();
    const wrapped = withAccountingInvoiceShadowTrigger(handoffPort(), {
      accountingPort, invoicePolicyReader: readerFor(null),
    });

    await wrapped.handOffCommerceFulfillmentOrder({
      idempotencyKey: "handoff-1", fulfillmentOrderId: FULFILLMENT_ORDER_ID, actorUserId: "actor",
    });
    expect(accountingPort.requestInvoiceIssueFromFulfillmentHandoff).toHaveBeenCalledTimes(1);
  });

  it.each([
    ["issue", 1],
    ["suppress", 0],
    ["channel_issues", 0],
  ] as const)("auto-dispatch paid trigger with policy %s requests %i time(s)", async (invoicePolicy, calls) => {
    const accountingPort = accountingSpy();
    const wrapped = withAutoDispatchAccountingInvoiceTrigger(paidPort(), {
      accountingPort, issueTrigger: "paid", invoicePolicyReader: readerFor(invoicePolicy),
    });

    await wrapped.ensureFulfilledFromPaidOrder({
      orderUuid: ORDER_UUID, outboxEventId: "evt-1", signal: new AbortController().signal,
    });
    expect(accountingPort.requestInvoiceIssueFromPaidOrder).toHaveBeenCalledTimes(calls);
  });

  it.each([
    ["issue", 1],
    ["suppress", 0],
    ["channel_issues", 0],
  ] as const)("auto-dispatch handoff trigger with policy %s requests %i time(s)", async (invoicePolicy, calls) => {
    const accountingPort = accountingSpy();
    const wrapped = withAutoDispatchAccountingInvoiceTrigger(paidPort(), {
      accountingPort, issueTrigger: "handoff", invoicePolicyReader: readerFor(invoicePolicy),
    });

    await wrapped.ensureFulfilledFromPaidOrder({
      orderUuid: ORDER_UUID, outboxEventId: "evt-1", signal: new AbortController().signal,
    });
    expect(accountingPort.requestInvoiceIssueFromFulfillmentHandoff).toHaveBeenCalledTimes(calls);
  });

  it("auto-dispatch STILL FULFILLS a suppressed order — only the document is refused", async () => {
    const accountingPort = accountingSpy();
    const port = paidPort();
    const wrapped = withAutoDispatchAccountingInvoiceTrigger(port, {
      accountingPort, issueTrigger: "paid", invoicePolicyReader: readerFor("suppress"),
    });

    await expect(wrapped.ensureFulfilledFromPaidOrder({
      orderUuid: ORDER_UUID, outboxEventId: "evt-1", signal: new AbortController().signal,
    })).resolves.toMatchObject({ kind: "completed" });
    expect(port.ensureFulfilledFromPaidOrder).toHaveBeenCalledTimes(1);
  });

  it("a policy read failure is fail-soft exactly like any other accounting error", async () => {
    const accountingPort = accountingSpy();
    const reader = {
      readOrderInvoicePolicy: async () => { throw new Error("policy read down"); },
    };
    const wrapped = withAutoDispatchAccountingInvoiceTrigger(paidPort(), {
      accountingPort, issueTrigger: "paid", invoicePolicyReader: reader,
    });

    await expect(wrapped.ensureFulfilledFromPaidOrder({
      orderUuid: ORDER_UUID, outboxEventId: "evt-1", signal: new AbortController().signal,
    })).resolves.toMatchObject({ kind: "completed" });
    expect(accountingPort.requestInvoiceIssueFromPaidOrder).not.toHaveBeenCalled();
  });
});
