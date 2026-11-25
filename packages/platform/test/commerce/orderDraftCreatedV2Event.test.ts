import { z } from "zod";
import { expect, it } from "vitest";
import { COMMERCE_ORDER_DRAFT_CREATED_EVENT_TYPE, createCommerceOutboxEventSchemas } from "../../src/commerce/outboxEventSchemas.js";
import {
  COMMERCE_ORDER_DRAFT_CREATED_V2_EVENT_TYPE, readCommerceOrderDraftCreatedV2Event,
} from "../../src/commerce/server/orderDraftCreatedV2Event.js";

const eventId = "f1376366-d0ca-44c1-8704-74439dc21c0d";
const orderId = "81a88fd7-b88b-4c84-adea-77344d1e3360";
const quoteId = "bfad3746-70a4-428c-9469-8e328eb1c4d7";
const snapshotRef = "993c2079-28f8-47c2-8098-bcc024b8dba4";
const timestamp = "2026-06-05T10:00:00.123456Z";
const payload = { orderId, quoteId, acceptedMoneyDigest: "a".repeat(64), destinationSnapshotRef: snapshotRef };
const record = { event_type: "commerce.order_draft.created.v2", id: eventId, aggregate_type: "commerce_order",
  aggregate_id: orderId, created_at: timestamp, available_at: timestamp, processed_at: null,
  idempotency_key: "fixture-secret", status: "processing", attempts: 1, payload,
  error: "fixture-error", metadata: { claimToken: "fixture-token" } };

it("reads exactly the draft-created v2 references", () => {
  expect(COMMERCE_ORDER_DRAFT_CREATED_V2_EVENT_TYPE).toBe(record.event_type);
  expect(readCommerceOrderDraftCreatedV2Event(Object.assign(Object.create(null), record))).toStrictEqual({ eventId, ...payload });
});

it("draft_created_reader_ignores_other_versions", () => {
  for (const event_type of ["commerce.order_draft.created.v1", "commerce.order_draft.created.v3",
    "commerce.order_draft.created", "commerce.other.v2"]) {
    expect(readCommerceOrderDraftCreatedV2Event({ event_type })).toBeNull();
  }
  for (const value of [null, 1, "event", {}, []]) expect(readCommerceOrderDraftCreatedV2Event(value)).toBeNull();
  const legacy = createCommerceOutboxEventSchemas({ quoteSnapshotSchema: z.unknown(), orderDraftSnapshotSchema: z.unknown(), snapshotPairSchema: z.unknown() });
  expect(() => legacy.parseCommerceOrderDraftCreatedOutboxEvent(record)).toThrow();
  const legacyRow = { ...record, event_type: COMMERCE_ORDER_DRAFT_CREATED_EVENT_TYPE,
    payload: { orderId: "order_" + orderId, orderUuid: orderId, quoteSnapshot: {}, orderDraftSnapshot: {} } };
  expect(readCommerceOrderDraftCreatedV2Event(legacyRow)).toBeNull();
  expect(legacy.parseCommerceOrderDraftCreatedOutboxEvent(legacyRow)).toMatchObject({
    contractVersion: "commerce.order_draft.created.v1", id: eventId, payload: legacyRow.payload,
  });
});

it.each([
  [{ aggregate_id: quoteId }, "/aggregate_id"],
  [{ aggregate_type: "other" }, "/aggregate_type"],
  [{ payload: { ...payload, acceptedMoneyDigest: "bad" } }, "/payload/acceptedMoneyDigest"],
  [{ payload: { ...payload, destinationSnapshotRef: null } }, "/payload/destinationSnapshotRef"],
  [{ payload: { ...payload, email: "forbidden" } }, "/payload/email"],
  [{ "extra/key~": true }, "/extra~1key~0"],
  [{ created_at: "yesterday" }, "/created_at"],
  [{ available_at: null }, "/available_at"],
  [{ processed_at: 42 }, "/processed_at"],
  [{ attempts: -1 }, "/attempts"],
  [{ idempotency_key: false }, "/idempotency_key"],
  [{ status: 3 }, "/status"],
  [{ error: {} }, "/error"],
  [{ metadata: [] }, "/metadata"],
])("refuses a v2 row with an invalid field", (patch, field) => {
  let refusal: unknown;
  try { readCommerceOrderDraftCreatedV2Event({ ...record, ...patch }); } catch (error) { refusal = error; }
  expect(Object.getPrototypeOf(refusal)).toBe(Error.prototype);
  expect(Reflect.ownKeys(refusal as object).filter(key => key !== "stack").sort()).toEqual(["code", "field", "message", "remedy"]);
  const code = "order_draft_created_v2_invalid";
  expect(refusal).toMatchObject({ message: code, code, field,
    remedy: "The draft-created v2 event does not match its documented payload. Leave the row for the producing owner to correct. Other event types are ignored." });
});
