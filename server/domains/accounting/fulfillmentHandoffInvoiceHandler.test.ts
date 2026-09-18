import { describe, expect, it, vi } from "vitest";
import type { AccountingInvoiceIssuePort } from "../../../src/domains/accounting/ports.js";
import { COMMERCE_FULFILLMENT_HANDED_OVER_EVENT_TYPE } from "../../../src/lib/fulfillmentHandoffOutboxContract.js";
import {
  createFulfillmentHandoffInvoiceHandler,
  createFulfillmentHandoffReceiptHandler,
} from "./fulfillmentHandoffInvoiceHandler.js";
import { AccountingInvoicePersistenceError } from "../../../src/domains/accounting/ports.js";

describe("fulfillment handoff invoice outbox handler", () => {
  it("drains the validated public handoff receipt without repeating its parent side effect", async () => {
    const accountingPort = portStub();
    const handler = createFulfillmentHandoffReceiptHandler({ accountingPort, providerKind: "probe-ledger" });
    const publicRow = { ...row(), payload: {
      shipmentUuid: "11111111-1111-4111-8111-111111111111",
      orderUuid: "22222222-2222-4222-8222-222222222222",
      occurredAt: "2026-07-16T10:30:00.000Z",
    } };

    await expect(handler.handle(publicRow, new AbortController().signal)).resolves.toEqual({
      kind: "processed",
      detail: {
        accountingInvoiceId: "invoice-1",
        accountingInvoiceStatus: "issue_requested",
        accountingInvoiceReplayed: false,
      },
    });
    expect(accountingPort.requestInvoiceIssueFromPaidOrder).toHaveBeenCalledWith({
      idempotencyKey: `${publicRow.idempotency_key}:accounting-invoice-paid`,
      orderId: "22222222-2222-4222-8222-222222222222",
      providerKind: "probe-ledger",
    });
  });

  it("never ACKs a valid external handoff when durable accounting fails", async () => {
    const accountingPort = portStub();
    accountingPort.requestInvoiceIssueFromPaidOrder.mockRejectedValueOnce(new Error("accounting unavailable"));
    const handler = createFulfillmentHandoffReceiptHandler({ accountingPort, providerKind: "probe-ledger" });

    await expect(handler.handle(row(), new AbortController().signal)).resolves.toEqual({
      kind: "retry",
      reason: "accounting unavailable",
    });
  });
  it("requests the existing accounting invoice duty with a stable key", async () => {
    const accountingPort = portStub();
    const handler = createFulfillmentHandoffInvoiceHandler({
      accountingPort,
      providerKind: "fakturownia",
      issueTrigger: "handoff",
    });

    await expect(handler.handle(row(), new AbortController().signal)).resolves.toEqual({
      kind: "processed",
      detail: {
        accountingInvoiceId: "invoice-1",
        accountingInvoiceStatus: "issue_requested",
        accountingInvoiceReplayed: false,
      },
    });
    expect(accountingPort.requestInvoiceIssueFromFulfillmentHandoff).toHaveBeenCalledWith({
      idempotencyKey:
        "fulfillment_handed_over:11111111-1111-4111-8111-111111111111:accounting-invoice",
      fulfillmentOrderId: "11111111-1111-4111-8111-111111111111",
      providerKind: "fakturownia",
    });
  });

  it("discards an invalid payload and retries transient persistence failures", async () => {
    const accountingPort = portStub();
    const handler = createFulfillmentHandoffInvoiceHandler({
      accountingPort,
      providerKind: "fakturownia",
      issueTrigger: "handoff",
    });

    await expect(
      handler.handle({ ...row(), payload: { orderUuid: row().aggregate_id } }, new AbortController().signal),
    ).resolves.toEqual({
      kind: "discard",
      reason: "fulfillment_handoff_payload_invalid",
    });

    accountingPort.requestInvoiceIssueFromFulfillmentHandoff.mockRejectedValueOnce(
      new Error("database unavailable"),
    );
    await expect(handler.handle(row(), new AbortController().signal)).resolves.toEqual({
      kind: "retry",
      reason: "database unavailable",
    });
  });

  it("discards permanently non-retryable issue-request failures", async () => {
    const accountingPort = portStub();
    const handler = createFulfillmentHandoffInvoiceHandler({
      accountingPort,
      providerKind: "fakturownia",
      issueTrigger: "handoff",
    });

    // 22023 == the RPC's not-found / validation RAISEs (e.g. the fulfillment
    // order was deleted after the handed_over event was emitted). Retrying can
    // never succeed, so the event is discarded, not retry-looped into a `failed`
    // backlog that blocks the staging outbox-preview gate.
    accountingPort.requestInvoiceIssueFromFulfillmentHandoff.mockRejectedValueOnce(
      new AccountingInvoicePersistenceError("Accounting invoice issue request failed", "22023"),
    );
    await expect(handler.handle(row(), new AbortController().signal)).resolves.toEqual({
      kind: "discard",
      reason: "Accounting invoice issue request failed (22023)",
    });

    // 23514 == the #1811 provider-immutability guard.
    accountingPort.requestInvoiceIssueFromFulfillmentHandoff.mockRejectedValueOnce(
      new AccountingInvoicePersistenceError("Accounting invoice issue request failed", "23514"),
    );
    await expect(handler.handle(row(), new AbortController().signal)).resolves.toEqual({
      kind: "discard",
      reason: "Accounting invoice issue request failed (23514)",
    });
  });

  it("classifies a deleted-aggregate 22023 as a benign discard with an explicit reason", async () => {
    const accountingPort = portStub();
    const handler = createFulfillmentHandoffInvoiceHandler({
      accountingPort,
      providerKind: "fakturownia",
      issueTrigger: "handoff",
    });

    // The fulfillment order was deleted (orphan from smoke/order cleanup) before
    // the async handed_over event dispatched: discarding is expected, so it is
    // flagged benign and the reason names the specific RAISE identifier.
    accountingPort.requestInvoiceIssueFromFulfillmentHandoff.mockRejectedValueOnce(
      new AccountingInvoicePersistenceError(
        "Accounting invoice issue request failed",
        "22023",
        "accounting_invoice_handoff_not_found",
      ),
    );
    await expect(handler.handle(row(), new AbortController().signal)).resolves.toEqual({
      kind: "discard",
      benign: true,
      reason:
        "Accounting invoice issue request failed: accounting_invoice_handoff_not_found (22023)",
    });
  });

  it("keeps a non-orphan 22023 as a non-benign discard so it stays visible", async () => {
    const accountingPort = portStub();
    const handler = createFulfillmentHandoffInvoiceHandler({
      accountingPort,
      providerKind: "fakturownia",
      issueTrigger: "handoff",
    });

    // A handed_over order with no succeeded payment is a genuine anomaly, not an
    // orphan cleanup — discard (retrying can't help) but do NOT mark benign, so
    // it keeps error-level visibility.
    accountingPort.requestInvoiceIssueFromFulfillmentHandoff.mockRejectedValueOnce(
      new AccountingInvoicePersistenceError(
        "Accounting invoice issue request failed",
        "22023",
        "accounting_invoice_payment_not_succeeded",
      ),
    );
    await expect(handler.handle(row(), new AbortController().signal)).resolves.toEqual({
      kind: "discard",
      reason:
        "Accounting invoice issue request failed: accounting_invoice_payment_not_succeeded (22023)",
    });
  });

  it("retries a persistence failure carrying a transient SQLSTATE", async () => {
    const accountingPort = portStub();
    const handler = createFulfillmentHandoffInvoiceHandler({
      accountingPort,
      providerKind: "fakturownia",
      issueTrigger: "handoff",
    });

    // 40001 == serialization_failure — genuinely retryable.
    accountingPort.requestInvoiceIssueFromFulfillmentHandoff.mockRejectedValueOnce(
      new AccountingInvoicePersistenceError("Accounting invoice issue request failed", "40001"),
    );
    await expect(handler.handle(row(), new AbortController().signal)).resolves.toEqual({
      kind: "retry",
      reason: "Accounting invoice issue request failed (40001)",
    });
  });

  it("retries without touching persistence when already aborted", async () => {
    const accountingPort = portStub();
    const handler = createFulfillmentHandoffInvoiceHandler({
      accountingPort,
      providerKind: "fakturownia",
      issueTrigger: "handoff",
    });
    const controller = new AbortController();
    controller.abort();

    await expect(handler.handle(row(), controller.signal)).resolves.toEqual({
      kind: "retry",
      reason: "fulfillment_handoff_handler_aborted",
    });
    expect(accountingPort.requestInvoiceIssueFromFulfillmentHandoff).not.toHaveBeenCalled();
  });

  it("replays the durable paid-order request when issuance runs at paid", async () => {
    const accountingPort = portStub();
    const handler = createFulfillmentHandoffInvoiceHandler({
      accountingPort,
      providerKind: "fakturownia",
      issueTrigger: "paid",
    });

    await expect(handler.handle(row(), new AbortController().signal)).resolves.toEqual({
      kind: "processed",
      detail: {
        accountingInvoiceId: "invoice-1",
        accountingInvoiceStatus: "issue_requested",
        accountingInvoiceReplayed: false,
      },
    });
    expect(accountingPort.requestInvoiceIssueFromFulfillmentHandoff).not.toHaveBeenCalled();
    expect(accountingPort.requestInvoiceIssueFromPaidOrder).toHaveBeenCalledWith({
      idempotencyKey:
        "fulfillment_handed_over:11111111-1111-4111-8111-111111111111:accounting-invoice-paid",
      orderId: "22222222-2222-4222-8222-222222222222",
      providerKind: "fakturownia",
    });
  });
});

describe("channel invoice policy at the handoff outbox handlers (wave B6)", () => {
  const readerFor = (invoicePolicy: string | null) => ({
    readOrderInvoicePolicy: vi.fn(async () =>
      invoicePolicy === null ? null : { sourceKind: "marketplace", invoicePolicy }),
  });

  it.each(["handoff", "paid"] as const)("issues for a storefront order on the %s trigger", async (issueTrigger) => {
    const accountingPort = portStub();
    const handler = createFulfillmentHandoffInvoiceHandler({
      accountingPort, providerKind: "probe-ledger", issueTrigger,
      invoicePolicyReader: readerFor(null),
    });

    await expect(handler.handle(row(), new AbortController().signal))
      .resolves.toMatchObject({ kind: "processed", detail: { accountingInvoiceId: "invoice-1" } });
  });

  it("issues for a channel whose operator declared `issue`", async () => {
    const accountingPort = portStub();
    const handler = createFulfillmentHandoffInvoiceHandler({
      accountingPort, providerKind: "probe-ledger", issueTrigger: "handoff",
      invoicePolicyReader: readerFor("issue"),
    });

    await expect(handler.handle(row(), new AbortController().signal))
      .resolves.toMatchObject({ kind: "processed", detail: { accountingInvoiceId: "invoice-1" } });
    expect(accountingPort.requestInvoiceIssueFromFulfillmentHandoff).toHaveBeenCalledTimes(1);
  });

  it("records `suppress` as a settled decision and requests nothing", async () => {
    const accountingPort = portStub();
    const handler = createFulfillmentHandoffInvoiceHandler({
      accountingPort, providerKind: "probe-ledger", issueTrigger: "handoff",
      invoicePolicyReader: readerFor("suppress"),
    });

    await expect(handler.handle(row(), new AbortController().signal)).resolves.toEqual({
      kind: "processed",
      detail: { invoicePolicy: "suppress", accountingInvoiceSkipped: "suppress" },
    });
    expect(accountingPort.requestInvoiceIssueFromFulfillmentHandoff).not.toHaveBeenCalled();
    expect(accountingPort.requestInvoiceIssueFromPaidOrder).not.toHaveBeenCalled();
  });

  it("stamps invoiceIssuedBy=channel for `channel_issues` and requests nothing", async () => {
    const accountingPort = portStub();
    const handler = createFulfillmentHandoffInvoiceHandler({
      accountingPort, providerKind: "probe-ledger", issueTrigger: "paid",
      invoicePolicyReader: readerFor("channel_issues"),
    });

    await expect(handler.handle(row(), new AbortController().signal)).resolves.toEqual({
      kind: "processed",
      detail: {
        invoicePolicy: "channel_issues",
        invoiceIssuedBy: "channel",
        accountingInvoiceSkipped: "channel_issues",
      },
    });
    expect(accountingPort.requestInvoiceIssueFromPaidOrder).not.toHaveBeenCalled();
  });

  it("retries a policy read failure rather than settling the event", async () => {
    const accountingPort = portStub();
    const handler = createFulfillmentHandoffInvoiceHandler({
      accountingPort, providerKind: "probe-ledger", issueTrigger: "handoff",
      invoicePolicyReader: {
        readOrderInvoicePolicy: async () => { throw new Error("policy read down"); },
      },
    });

    await expect(handler.handle(row(), new AbortController().signal))
      .resolves.toMatchObject({ kind: "retry", reason: "policy read down" });
  });

  it("applies the same gate to the direct-bundle receipt handler", async () => {
    const accountingPort = portStub();
    const suppressed = createFulfillmentHandoffReceiptHandler({
      accountingPort, providerKind: "probe-ledger", invoicePolicyReader: readerFor("suppress"),
    });
    await expect(suppressed.handle(row(), new AbortController().signal)).resolves.toEqual({
      kind: "processed",
      detail: { invoicePolicy: "suppress", accountingInvoiceSkipped: "suppress" },
    });
    expect(accountingPort.requestInvoiceIssueFromPaidOrder).not.toHaveBeenCalled();

    const storefront = createFulfillmentHandoffReceiptHandler({
      accountingPort, providerKind: "probe-ledger", invoicePolicyReader: readerFor(null),
    });
    await expect(storefront.handle(row(), new AbortController().signal))
      .resolves.toMatchObject({ kind: "processed", detail: { accountingInvoiceId: "invoice-1" } });
  });
});

function portStub(): AccountingInvoiceIssuePort & {
  requestInvoiceIssueFromFulfillmentHandoff: ReturnType<
    typeof vi.fn<AccountingInvoiceIssuePort["requestInvoiceIssueFromFulfillmentHandoff"]>
  >;
  requestInvoiceIssueFromPaidOrder: ReturnType<
    typeof vi.fn<AccountingInvoiceIssuePort["requestInvoiceIssueFromPaidOrder"]>
  >;
} {
  return {
    requestInvoiceIssueFromFulfillmentHandoff: vi.fn(async () => ({
      invoice: {
        id: "invoice-1",
        invoiceRef: "ORDER-1:base",
        status: "issue_requested",
        replayed: false,
      },
    })),
    requestInvoiceIssueFromPaidOrder: vi.fn(async () => ({
      invoice: {
        id: "invoice-1",
        invoiceRef: "ORDER-1:base",
        status: "issue_requested",
        replayed: false,
      },
    })),
  };
}

function row() {
  return {
    id: "event-1",
    created_at: "2026-07-16T10:30:00.000Z",
    available_at: "2026-07-16T10:30:00.000Z",
    processed_at: null,
    aggregate_type: "commerce_fulfillment_order",
    aggregate_id: "11111111-1111-4111-8111-111111111111",
    event_type: COMMERCE_FULFILLMENT_HANDED_OVER_EVENT_TYPE,
    idempotency_key: "fulfillment_handed_over:11111111-1111-4111-8111-111111111111",
    status: "pending",
    attempts: 0,
    payload: {
      fulfillmentOrderId: "11111111-1111-4111-8111-111111111111",
      orderUuid: "22222222-2222-4222-8222-222222222222",
      occurredAt: "2026-07-16T10:30:00.000Z",
    },
    error: null,
    metadata: {},
  };
}
