import { expect, it, vi } from "vitest";
import { createFulfillmentHandoffInvoiceHandler, withAccountingInvoiceShadowTrigger, withAutoDispatchAccountingInvoiceTrigger } from "../../src/invoicing/index.js";

it("preserves handler descriptor, validation, abort, suppression and permanent/transient dispositions", async () => {
  const request = vi.fn(async () => ({ accountingInvoiceId: "invoice", accountingInvoiceStatus: "pending", accountingInvoiceReplayed: true }));
  const decide = vi.fn(async () => ({ issue: true, action: "issue" as "issue" | "suppress", detail: {} as Record<string, unknown> }));
  const handler = createFulfillmentHandoffInvoiceHandler({
    descriptor: { eventType: "host.handoff", timeoutMs: 10000 },
    parsePayload: (value: unknown) => typeof value === "string" ? { success: true as const, data: value } : { success: false as const },
    decide, request,
    errorDetails: (error: unknown) => error as { message: string; causeCode?: string; causeMessage?: string },
  });
  expect({ eventType: handler.eventType, timeoutMs: handler.timeoutMs }).toEqual({ eventType: "host.handoff", timeoutMs: 10000 });
  const signal = new AbortController().signal;
  expect(await handler.handle({ payload: null }, signal)).toEqual({ kind: "discard", reason: "fulfillment_handoff_payload_invalid" });
  const aborted = new AbortController(); aborted.abort();
  expect(await handler.handle({ payload: "order" }, aborted.signal)).toEqual({ kind: "retry", reason: "fulfillment_handoff_handler_aborted" });
  expect(request).not.toHaveBeenCalled();
  expect(await handler.handle({ payload: "order" }, signal)).toEqual({ kind: "processed", detail: { accountingInvoiceId: "invoice", accountingInvoiceStatus: "pending", accountingInvoiceReplayed: true } });
  decide.mockResolvedValueOnce({ issue: false, action: "suppress", detail: { accountingInvoiceSkipped: "suppress" } });
  expect(await handler.handle({ payload: "order" }, signal)).toEqual({ kind: "processed", detail: { accountingInvoiceSkipped: "suppress" } });
  expect(request).toHaveBeenCalledTimes(1);
  for (const [causeCode, causeMessage, expected] of [
    ["22023", "accounting_invoice_order_not_found", { kind: "discard", benign: true }],
    ["23514", "accounting_invoice_provider_mismatch", { kind: "discard" }],
    ["40001", "retry", { kind: "retry" }],
  ] as const) {
    request.mockRejectedValueOnce({ message: "request failed", causeCode, causeMessage });
    expect(await handler.handle({ payload: "order" }, signal)).toEqual({ ...expected, reason: `request failed: ${causeMessage} (${causeCode})` });
  }
});

it("keeps direct handoff/paid key scopes, suppressed receipts, and fail-soft fulfillment with the strict standalone option", async () => {
  const trace: string[] = [];
  const accountingPort = {
    requestInvoiceIssueFromPaidOrder: vi.fn(async () => { trace.push("invoice-paid"); }),
    requestInvoiceIssueFromFulfillmentHandoff: vi.fn(async () => { trace.push("invoice-handoff"); }),
  };
  const options = { accountingPort, providerKind: "host-fiscal", keys: { shadow: (key: string) => `${key}:accounting-invoice`, paid: (id: string) => `order-paid-dispatch:${id}:accounting-invoice-paid`, handoff: (id: string) => `order-paid-dispatch:${id}:accounting-invoice` } };
  const fulfillment = { ensureFulfilledFromPaidOrder: vi.fn(async (_input: { orderUuid: string; outboxEventId: string; signal: AbortSignal }) => { trace.push("fulfillment"); return { kind: "completed" as const, detail: { fulfillmentOrderId: "shipment" } }; }) };
  const input = { orderUuid: "order", outboxEventId: "event", signal: new AbortController().signal };
  await withAutoDispatchAccountingInvoiceTrigger(fulfillment, { ...options, issueTrigger: "paid" }).ensureFulfilledFromPaidOrder(input);
  expect(trace).toEqual(["invoice-paid", "fulfillment"]);
  expect(accountingPort.requestInvoiceIssueFromPaidOrder).toHaveBeenCalledWith({ idempotencyKey: "order-paid-dispatch:order:accounting-invoice-paid", orderId: "order", providerKind: "host-fiscal" });
  trace.length = 0;
  await withAutoDispatchAccountingInvoiceTrigger(fulfillment, options).ensureFulfilledFromPaidOrder(input);
  expect(trace).toEqual(["fulfillment", "invoice-handoff"]);
  expect(accountingPort.requestInvoiceIssueFromFulfillmentHandoff).toHaveBeenCalledWith({ idempotencyKey: "order-paid-dispatch:order:accounting-invoice", fulfillmentOrderId: "shipment", providerKind: "host-fiscal" });
  const request = { idempotencyKey: "operator-handoff", fulfillmentOrderId: "shipment", actorUserId: "actor" };
  const hostResult = { handedOver: true };
  const shadow = { handOffCommerceFulfillmentOrder: vi.fn(async (_request: { idempotencyKey: string; fulfillmentOrderId: string; actorUserId: string }) => hostResult) };
  expect(await withAccountingInvoiceShadowTrigger(shadow, { ...options, accountingPort: { requestInvoiceIssueFromFulfillmentHandoff: accountingPort.requestInvoiceIssueFromFulfillmentHandoff } }).handOffCommerceFulfillmentOrder(request)).toBe(hostResult);
  expect(accountingPort.requestInvoiceIssueFromFulfillmentHandoff).toHaveBeenLastCalledWith({ idempotencyKey: "operator-handoff:accounting-invoice", fulfillmentOrderId: "shipment", providerKind: "host-fiscal" });
  accountingPort.requestInvoiceIssueFromFulfillmentHandoff.mockClear();
  for (const action of ["suppress", "channel_issues"] as const) {
    await withAutoDispatchAccountingInvoiceTrigger(fulfillment, { ...options, invoicePolicyReader: { readOrderInvoicePolicy: async () => action } }).ensureFulfilledFromPaidOrder(input);
  }
  expect(accountingPort.requestInvoiceIssueFromFulfillmentHandoff).not.toHaveBeenCalled();
  accountingPort.requestInvoiceIssueFromPaidOrder.mockRejectedValueOnce(new Error("invoice unavailable"));
  expect(await withAutoDispatchAccountingInvoiceTrigger(fulfillment, { ...options, issueTrigger: "paid" }).ensureFulfilledFromPaidOrder(input)).toMatchObject({ kind: "completed" });
  accountingPort.requestInvoiceIssueFromFulfillmentHandoff.mockRejectedValueOnce(new Error("invoice unavailable"));
  expect(await withAccountingInvoiceShadowTrigger(shadow, options).handOffCommerceFulfillmentOrder(request)).toBe(hostResult);
  accountingPort.requestInvoiceIssueFromFulfillmentHandoff.mockRejectedValueOnce(new Error("strict standalone"));
  await expect(withAccountingInvoiceShadowTrigger(shadow, { ...options, failOnAccountingError: true }).handOffCommerceFulfillmentOrder(request)).rejects.toThrow("strict standalone");
});
