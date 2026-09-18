import { COMMERCE_ORDER_PAID_EVENT_TYPE } from "../../../../../src/domains/commerce/outboxEventContracts.js";
import type { CommerceOmsClient } from "./types.js";

const ORDER_PAID_OUTBOX_COLUMNS = "id,event_type,status,aggregate_id,created_at,available_at,attempts";
const ORDER_PAID_OUTBOX_BASE_COLUMNS = "id,event_type,status,aggregate_id,created_at,available_at";

export async function readOrderPaidOutboxEvents(client: CommerceOmsClient, orderId: string) {
  const primary = await selectOrderPaidOutboxEvents(client, orderId, ORDER_PAID_OUTBOX_COLUMNS);
  if (!isMissingAttemptsColumn(primary.error)) return primary;
  return selectOrderPaidOutboxEvents(client, orderId, ORDER_PAID_OUTBOX_BASE_COLUMNS);
}

function selectOrderPaidOutboxEvents(
  client: CommerceOmsClient,
  orderId: string,
  columns: string,
) {
  return client
    .from("outbox_events")
    .select(columns)
    .eq("event_type", COMMERCE_ORDER_PAID_EVENT_TYPE)
    .eq("aggregate_id", orderId)
    .order("created_at", { ascending: false });
}

function isMissingAttemptsColumn(error: { message?: string; details?: string; hint?: string } | null): boolean {
  if (!error) return false;
  const text = `${error.message ?? ""} ${error.details ?? ""} ${error.hint ?? ""}`.toLowerCase();
  return text.includes("attempts");
}
