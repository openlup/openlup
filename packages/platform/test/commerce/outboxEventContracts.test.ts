import { expect, expectTypeOf, it } from "vitest";
import { z } from "zod";
import type { OutboxEventRow } from "@openlup/core/outbox";
import { commerceOrderPaidOutboxRecordSchema, commerceOrderPaidPayloadSchema,
  commerceOrderReviewRequestPayloadSchema, commerceProductBackInStockPayloadSchema,
  createCommerceOutboxEventSchemas, COMMERCE_ORDER_PAID_EVENT_TYPE,
  COMMERCE_ORDER_DRAFT_CREATED_EVENT_TYPE } from "../../src/commerce/index.js";

const id = "550e8400-e29b-41d4-a716-446655440001";
const timestamp = new Date(0).toISOString();
const paidPayload = { orderId: `order_${id}`, orderUuid: id, mode: "future_mode", occurredAt: timestamp };
const envelope = { id, created_at: timestamp, available_at: timestamp, processed_at: null,
  aggregate_type: "commerce_order", aggregate_id: id, event_type: COMMERCE_ORDER_PAID_EVENT_TYPE,
  idempotency_key: "checkout-example-1", status: "pending", attempts: 0, payload: paidPayload,
  error: null, metadata: {} };

it("fits the existing core envelope and preserves paid-event refusal boundaries", () => {
  const row = commerceOrderPaidOutboxRecordSchema.parse(envelope);
  expectTypeOf(row).toExtend<OutboxEventRow>();
  expect(row).toEqual(envelope);
  expect(commerceOrderPaidPayloadSchema.parse(paidPayload).mode).toBe("future_mode");
  expect(commerceOrderPaidPayloadSchema.safeParse({ ...paidPayload, orderId: "order_invalid" }).success).toBe(false);
  expect(commerceOrderPaidOutboxRecordSchema.safeParse({ ...envelope, aggregate_id: "550e8400-e29b-41d4-a716-446655440002" }).success).toBe(false);
  expect(commerceOrderPaidOutboxRecordSchema.safeParse({ ...envelope, status: "snoozed" }).success).toBe(false);
});

it("binds snapshot validation and translates the stored envelope without changing order", () => {
  const snapshotSchema = z.object({ revision: z.number().int() }).strict();
  const snapshotPairSchema = z.object({ quoteSnapshot: snapshotSchema, orderDraftSnapshot: snapshotSchema })
    .refine(pair => pair.quoteSnapshot.revision === pair.orderDraftSnapshot.revision);
  const schemas = createCommerceOutboxEventSchemas({ quoteSnapshotSchema: snapshotSchema,
    orderDraftSnapshotSchema: snapshotSchema, snapshotPairSchema });
  const record = { ...envelope, event_type: COMMERCE_ORDER_DRAFT_CREATED_EVENT_TYPE,
    payload: { orderId: `order_${id}`, orderUuid: id, quoteSnapshot: { revision: 1 }, orderDraftSnapshot: { revision: 1 } } };
  const parsed = schemas.parseCommerceOrderDraftCreatedOutboxEvent(record);
  expect(parsed).toEqual({ contractVersion: "commerce.order_draft.created.v1", id,
    createdAt: timestamp, availableAt: timestamp, processedAt: null, aggregateType: "commerce_order",
    aggregateId: id, eventType: COMMERCE_ORDER_DRAFT_CREATED_EVENT_TYPE, idempotencyKey: envelope.idempotency_key,
    status: "pending", attempts: 0, payload: record.payload, error: null, metadata: {} });
  expectTypeOf(parsed.payload.quoteSnapshot.revision).toEqualTypeOf<number>();
  expect(schemas.commerceOrderDraftCreatedOutboxRecordSchema.safeParse({ ...record,
    payload: { ...record.payload, orderDraftSnapshot: { revision: 2 } } }).success).toBe(false);
  expect(schemas.commerceOrderDraftCreatedOutboxRecordSchema.safeParse({ ...record,
    aggregate_id: "550e8400-e29b-41d4-a716-446655440002" }).success).toBe(false);
});

it("retains review extensions and strict stock notification payloads", () => {
  expect(commerceOrderReviewRequestPayloadSchema.parse({ orderId: "order-example", orderUuid: id, token: "opaque", extension: 1 }).extension).toBe(1);
  expect(commerceProductBackInStockPayloadSchema.parse({ sku: " ITEM-A ", email: "buyer@example.test" }).sku).toBe("ITEM-A");
  expect(commerceProductBackInStockPayloadSchema.safeParse({ sku: "ITEM-A", email: "invalid" }).success).toBe(false);
  expect(commerceProductBackInStockPayloadSchema.safeParse({ sku: "ITEM-A", email: "buyer@example.test", extension: 1 }).success).toBe(false);
});
