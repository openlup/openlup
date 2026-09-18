import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
  ACCOUNTING_ORDER_REVERSAL_REQUESTED_EVENT_TYPE,
  type AccountingOrderReversalRequested,
  accountingOrderReversalRequestedPayloadSchema,
} from "./outboxReversalContracts.js";

describe("accounting order reversal outbox contract", () => {
  it("names the independently consumable obligation and validates producer provenance", () => {
    const request: AccountingOrderReversalRequested = {
      eventType: ACCOUNTING_ORDER_REVERSAL_REQUESTED_EVENT_TYPE,
      idempotencyKey: "event-1:accounting-reversal",
      orderUuid: "11111111-1111-4111-8111-111111111111",
      reason: "order_refunded",
      payload: {
        outboxEventId: "event-1",
        eventType: "commerce.order.refunded",
        orderId: "ORDER-1",
      },
    };

    expect(accountingOrderReversalRequestedPayloadSchema.safeParse({
      businessIdempotencyKey: "order-1:reversal-request",
      orderUuid: request.orderUuid,
      orderId: request.payload.orderId,
      reason: request.reason,
      sourceEvent: { id: "payment-refund-1", eventType: "payment.refund.confirmed" },
    }).success).toBe(true);
    expect(accountingOrderReversalRequestedPayloadSchema.safeParse({
      orderUuid: request.orderUuid,
      orderId: request.payload.orderId,
      reason: request.reason,
      sourceEvent: { id: "payment-refund-1", eventType: "payment.refund.confirmed" },
    }).success).toBe(false);
    expect(request.eventType).toBe("accounting.order.reversal_requested");
    expect(request.payload.eventType).toBe("commerce.order.refunded");
  });

  it("matches the reversal RPC idempotency floor and rejects undeclared payload fields", () => {
    const payload = {
      businessIdempotencyKey: "order-1:reversal-request",
      orderUuid: "11111111-1111-4111-8111-111111111111",
      orderId: "ORDER-1",
      reason: "order_refunded",
      sourceEvent: { id: "payment-refund-1", eventType: "payment.refund.confirmed" },
    };

    expect(accountingOrderReversalRequestedPayloadSchema.safeParse({
      ...payload,
      businessIdempotencyKey: "short",
    }).success).toBe(false);
    expect(accountingOrderReversalRequestedPayloadSchema.safeParse({
      ...payload,
      unexpected: true,
    }).success).toBe(false);
    expect(accountingOrderReversalRequestedPayloadSchema.safeParse({
      ...payload,
      sourceEvent: { ...payload.sourceEvent, unexpected: true },
    }).success).toBe(false);
  });

  it("keeps the future event literal out of runtime producer surfaces", () => {
    const files = ["api", "server", "src"].flatMap(listTypeScriptFiles)
      .filter((file) => !/\.(test|spec)\.ts$/.test(file))
      .filter((file) => file !== "src/domains/accounting/outboxReversalContracts.ts");
    const literal = ACCOUNTING_ORDER_REVERSAL_REQUESTED_EVENT_TYPE;

    expect(files.filter((file) => readFileSync(file, "utf8").includes(literal))).toEqual([]);
  });
});

function listTypeScriptFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) return listTypeScriptFiles(path);
    return entry.isFile() && path.endsWith(".ts") ? [path] : [];
  });
}
