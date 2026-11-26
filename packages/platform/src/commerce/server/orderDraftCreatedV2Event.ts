import type { OutboxEventRow } from "@openlup/core/outbox";
import { z } from "zod";
import {
  commerceMoneyV2DigestSchema as digest,
  commerceMoneyV2UuidSchema as uuid,
} from "../../pricing/index.js";

/** @experimental Event type accepted by the private v2 draft reader. */
export const COMMERCE_ORDER_DRAFT_CREATED_V2_EVENT_TYPE = "commerce.order_draft.created.v2";

const timestamp = z.iso.datetime({ offset: true });
const payload = z.strictObject({
  orderId: uuid, quoteId: uuid, acceptedMoneyDigest: digest, destinationSnapshotRef: uuid,
});
const row = z.strictObject({
  id: uuid,
  created_at: timestamp,
  available_at: timestamp,
  processed_at: timestamp.nullable(),
  aggregate_type: z.literal("commerce_order"),
  aggregate_id: uuid,
  event_type: z.literal(COMMERCE_ORDER_DRAFT_CREATED_V2_EVENT_TYPE),
  idempotency_key: z.string(),
  status: z.string(),
  attempts: z.int().nonnegative(),
  payload,
  error: z.string().nullable(),
  metadata: z.record(z.string(), z.unknown()),
}).refine(value => value.aggregate_id === value.payload.orderId, { path: ["aggregate_id"] }) satisfies z.ZodType<OutboxEventRow>;

function invalid(path: readonly PropertyKey[]) {
  const code = "order_draft_created_v2_invalid";
  const field = "/" + path.map(key => String(key).replaceAll("~", "~0").replaceAll("/", "~1")).join("/");
  return Object.assign(new Error(code), {
    code, field,
    remedy: "The draft-created v2 event does not match its documented payload. Leave the row for the producing owner to correct. Other event types are ignored.",
  });
}

function snapshotObject(value: object) {
  return Object.fromEntries(Reflect.ownKeys(value).map(key => [key, Reflect.get(value, key)]));
}

/** @experimental Read the original references from a claimed v2 draft-created row. */
export function readCommerceOrderDraftCreatedV2Event(record: unknown) {
  if (record === null || typeof record !== "object" || Array.isArray(record)) return null;
  const snapshot = snapshotObject(record);
  if (snapshot.event_type !== COMMERCE_ORDER_DRAFT_CREATED_V2_EVENT_TYPE) return null;
  const symbol = Object.getOwnPropertySymbols(snapshot)[0];
  if (symbol) throw invalid([symbol]);
  const content: unknown = snapshot.payload;
  if (content !== null && typeof content === "object" && !Array.isArray(content)) {
    const payloadSnapshot = snapshotObject(content);
    const extra = Reflect.ownKeys(payloadSnapshot).find(key => !Object.hasOwn(payload.shape, key));
    if (extra !== undefined) throw invalid(["payload", extra]);
    snapshot.payload = payloadSnapshot;
  }
  const parsed = row.safeParse(snapshot);
  if (!parsed.success) {
    const issue = parsed.error.issues[0]!;
    throw invalid(issue.code === "unrecognized_keys" ? [...issue.path, issue.keys[0]!] : issue.path);
  }
  return { eventId: parsed.data.id, ...parsed.data.payload };
}
