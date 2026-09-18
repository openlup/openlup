import type { SupabaseClient } from "@supabase/supabase-js";
import type { CommunicationAdminEmailSendsReadPort } from "../../../src/domains/communications/ports.js";
import type { EmailHealthMetrics } from "../../domains/communications/emailHealthMetricsPort.js";
import type { Client, EmailSendWithTesterRow } from "./adminEmailSendsPort.js";

type UntypedSupabaseClient = SupabaseClient;
type EmailSendsRequest = Parameters<CommunicationAdminEmailSendsReadPort["getAdminEmailSends"]>[0];
type DeliveryRow = {
  email_send_id: string | null;
  status: string | null;
  last_error_code: string | null;
  outbox_event_id: string | null;
  aggregate_type: string | null;
  aggregate_id: string | null;
  provider_message_id: string | null;
};

const DELIVERIES_TABLE = "communication_email_deliveries";
const ATTEMPTED_STATUSES = [
  "sent", "delivered", "delivery_delayed", "failed", "bounced", "complained", "missed",
] as const;
const SENT_STATUSES = ["sent", "delivered"] as const;
const FAILED_STATUSES = ["failed", "bounced", "complained", "missed"] as const;
const SCHEDULED_STATUSES = ["planned", "queued"] as const;
interface CountableQuery {
  in(column: string, values: readonly string[]): CountableQuery;
  eq(column: string, value: string): CountableQuery;
  gte(column: string, value: string): CountableQuery;
  lt(column: string, value: string): CountableQuery;
  then: PromiseLike<{ count: number | null; error: { message?: string; code?: string } | null }>["then"];
}
interface DeliveriesClient {
  from(table: string): { select(columns: string, opts: { count: "exact"; head: true }): CountableQuery };
}
export async function readEmailHealthMetrics(
  client: DeliveriesClient,
  window: { windowStartIso: string; stuckBeforeIso: string },
): Promise<EmailHealthMetrics> {
  const count = async (apply: (q: CountableQuery) => CountableQuery): Promise<number> => {
    const base = client.from(DELIVERIES_TABLE).select("id", { count: "exact", head: true });
    const { count: n, error } = await apply(base);
    if (error) {
      throw new Error(`email_health_metrics_query_failed: ${error.message ?? error.code ?? "unknown"}`);
    }
    return n ?? 0;
  };

  const [attempted, sent, failed, delayed, permanentFailures, stuckProcessing, stuckScheduled] = await Promise.all([
    count((q) => q.gte("created_at", window.windowStartIso).in("status", ATTEMPTED_STATUSES)),
    count((q) => q.gte("created_at", window.windowStartIso).in("status", SENT_STATUSES)),
    count((q) => q.gte("created_at", window.windowStartIso).in("status", FAILED_STATUSES)),
    count((q) => q.gte("created_at", window.windowStartIso).eq("status", "delivery_delayed")),
    count((q) => q.gte("created_at", window.windowStartIso).eq("status", "failed")),
    count((q) => q.eq("status", "processing").lt("updated_at", window.stuckBeforeIso)),
    count((q) => q.in("status", SCHEDULED_STATUSES).lt("expected_send_at", window.stuckBeforeIso)),
  ]);

  return { attempted, sent, failed, delayed, permanentFailures, stuckProcessing, stuckScheduled };
}

export async function findMatchingEmailSendIds(client: Client, request: EmailSendsRequest): Promise<string[] | null> {
  const search = request.search.trim();
  if (!search) return null;
  const ids = new Set<string>();
  const testerIds = await findMatchingTesterIds(client, search);
  const clientIds = await findMatchingClientIds(client, search);
  if (testerIds.length > 0) await addSendIdsByTester(client, ids, testerIds);
  if (clientIds.length > 0) await addSendIdsByClient(client, ids, clientIds);
  await Promise.all([
    addSendIdsByEmailSendFields(client, ids, search),
    addSendIdsByDeliveryEvidence(client, ids, search),
    addSendIdsByOrderSearch(client, ids, search),
  ]);
  return [...ids];
}

async function findMatchingClientIds(client: Client, search: string): Promise<string[]> {
  if (!search.trim()) return [];
  const db = client as unknown as UntypedSupabaseClient;
  const pattern = [
    "first_name.ilike.%" + search + "%",
    "last_name.ilike.%" + search + "%",
    "email.ilike.%" + search + "%",
  ].join(",");
  const { data, error } = await db.from("clients").select("id").or(pattern).limit(100);
  if (error) throw error;
  return ((data ?? []) as Array<{ id?: unknown }>).map((clientRow) => String(clientRow.id ?? "")).filter(Boolean);
}

export async function enrichEmailSendsWithDeliveryEvidence(
  client: Client,
  sends: EmailSendWithTesterRow[],
): Promise<EmailSendWithTesterRow[]> {
  if (sends.length === 0) return sends;
  const deliveries = await readDeliveriesForSends(client, sends);
  const orderNumbers = await readOrderNumbers(client, [
    ...new Set(deliveries.filter(isCommerceOrderDelivery).map((row) => row.aggregate_id).filter(isString)),
  ]);
  return sends.map((send) => {
    const delivery = deliveries.find((row) => row.email_send_id === send.id || row.outbox_event_id === providerResponseText(send.provider_response, "outboxEventId")) ?? null;
    const orderNumber = delivery && isCommerceOrderDelivery(delivery) && delivery.aggregate_id
      ? orderNumbers.get(delivery.aggregate_id) ?? null
      : null;
    return {
      ...send,
      delivery_aggregate_id: delivery?.aggregate_id ?? providerResponseText(send.provider_response, "orderId"),
      delivery_last_error_code: delivery?.last_error_code ?? null,
      delivery_order_number: orderNumber,
      delivery_outbox_event_id: delivery?.outbox_event_id ?? providerResponseText(send.provider_response, "outboxEventId"),
      delivery_status: delivery?.status ?? null,
      recipient_label: recipientLabel(send, orderNumber, delivery && isCommerceOrderDelivery(delivery) ? delivery.aggregate_id : null),
    };
  });
}

async function findMatchingTesterIds(client: Client, search: string): Promise<string[]> {
  if (!search.trim()) return [];
  const pattern = [
    "first_name.ilike.%" + search + "%",
    "last_name.ilike.%" + search + "%",
    "email.ilike.%" + search + "%",
  ].join(",");
  const { data, error } = await client.from("testers").select("id").or(pattern);
  if (error) throw error;
  return (data ?? []).map((tester) => tester.id);
}

async function addSendIdsByTester(client: Client, ids: Set<string>, testerIds: string[]): Promise<void> {
  const { data, error } = await client.from("email_sends").select("id").in("tester_id", testerIds).limit(500);
  if (error) throw error;
  for (const row of data ?? []) addId(ids, row.id);
}

async function addSendIdsByClient(client: Client, ids: Set<string>, clientIds: string[]): Promise<void> {
  const db = client as unknown as UntypedSupabaseClient;
  const { data, error } = await db
    .from("communication_email_deliveries")
    .select("email_send_id")
    .in("client_id", clientIds)
    .not("email_send_id", "is", null)
    .limit(500);
  if (error) throw error;
  for (const row of (data ?? []) as Array<{ email_send_id?: unknown }>) addId(ids, row.email_send_id);
}

async function addSendIdsByEmailSendFields(client: Client, ids: Set<string>, search: string): Promise<void> {
  const pattern = [
    `template_slug.ilike.%${search}%`,
    `source.ilike.%${search}%`,
    `resend_id.ilike.%${search}%`,
    `provider_error.ilike.%${search}%`,
  ].join(",");
  const { data, error } = await client.from("email_sends").select("id").or(pattern).limit(500);
  if (error) throw error;
  for (const row of data ?? []) addId(ids, row.id);
  if (isUuid(search)) {
    const { data: idMatches, error: idError } = await client.from("email_sends").select("id").eq("id", search).limit(500);
    if (idError) throw idError;
    for (const row of idMatches ?? []) addId(ids, row.id);
  }
  await addSendIdsByProviderResponse(client, ids, "outboxEventId", search);
  await addSendIdsByProviderResponse(client, ids, "orderId", normalizeOrderSearch(search));
}

async function addSendIdsByProviderResponse(
  client: Client,
  ids: Set<string>,
  field: "outboxEventId" | "orderId",
  value: string,
): Promise<void> {
  if (!value) return;
  const { data, error } = await client
    .from("email_sends")
    .select("id")
    .eq(`provider_response->>${field}`, value)
    .limit(500);
  if (error) throw error;
  for (const row of data ?? []) addId(ids, row.id);
}

async function addSendIdsByDeliveryEvidence(client: Client, ids: Set<string>, search: string): Promise<void> {
  const db = client as unknown as UntypedSupabaseClient;
  const { data, error } = await db
    .from("communication_email_deliveries")
    .select("email_send_id")
    .or([
      `aggregate_id.ilike.%${normalizeOrderSearch(search)}%`,
      `provider_message_id.ilike.%${search}%`,
      `last_error_code.ilike.%${search}%`,
      `template_slug.ilike.%${search}%`,
    ].join(","))
    .not("email_send_id", "is", null)
    .limit(500);
  if (error) throw error;
  for (const row of (data ?? []) as Array<{ email_send_id?: unknown }>) addId(ids, row.email_send_id);
  if (!isUuid(search)) return;
  const { data: outboxMatches, error: outboxError } = await db
    .from("communication_email_deliveries")
    .select("email_send_id")
    .eq("outbox_event_id", search)
    .not("email_send_id", "is", null)
    .limit(500);
  if (outboxError) throw outboxError;
  for (const row of (outboxMatches ?? []) as Array<{ email_send_id?: unknown }>) addId(ids, row.email_send_id);
}

async function addSendIdsByOrderSearch(client: Client, ids: Set<string>, search: string): Promise<void> {
  const db = client as unknown as UntypedSupabaseClient;
  const normalized = normalizeOrderSearch(search);
  const orderQueries = [
    db.from("commerce_orders").select("id").or(`order_number.ilike.%${search}%`).limit(100),
  ];
  if (isUuid(normalized)) {
    orderQueries.push(db.from("commerce_orders").select("id").eq("id", normalized).limit(100));
  }
  const orderResults = await Promise.all(orderQueries);
  const orderError = orderResults.find((result) => result.error)?.error;
  if (orderError) throw orderError;
  const orderIds = orderResults.flatMap((result) =>
    ((result.data ?? []) as Array<{ id?: unknown }>).map((row) => String(row.id ?? "")).filter(Boolean),
  );
  if (orderIds.length === 0) return;
  const { data, error } = await db
    .from("communication_email_deliveries")
    .select("email_send_id")
    .eq("aggregate_type", "commerce_order")
    .in("aggregate_id", orderIds)
    .not("email_send_id", "is", null)
    .limit(500);
  if (error) throw error;
  for (const row of (data ?? []) as Array<{ email_send_id?: unknown }>) addId(ids, row.email_send_id);
}

async function readDeliveriesForSends(client: Client, sends: EmailSendWithTesterRow[]): Promise<DeliveryRow[]> {
  const db = client as unknown as UntypedSupabaseClient;
  const sendIds = sends.map((send) => send.id);
  const outboxEventIds = sends.map((send) => providerResponseText(send.provider_response, "outboxEventId")).filter(isString);
  const byId = sendIds.length
    ? await db.from("communication_email_deliveries").select("email_send_id, status, last_error_code, outbox_event_id, aggregate_type, aggregate_id, provider_message_id").in("email_send_id", sendIds)
    : { data: [], error: null };
  const byOutbox = outboxEventIds.length
    ? await db.from("communication_email_deliveries").select("email_send_id, status, last_error_code, outbox_event_id, aggregate_type, aggregate_id, provider_message_id").in("outbox_event_id", outboxEventIds)
    : { data: [], error: null };
  if (byId.error || byOutbox.error) throw byId.error ?? byOutbox.error;
  const rows = [...((byId.data ?? []) as DeliveryRow[]), ...((byOutbox.data ?? []) as DeliveryRow[])];
  const seen = new Set<string>();
  return rows.filter((row) => {
    const key = `${row.email_send_id ?? ""}:${row.outbox_event_id ?? ""}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

async function readOrderNumbers(client: Client, orderIds: string[]): Promise<Map<string, string>> {
  const map = new Map<string, string>();
  if (orderIds.length === 0) return map;
  const db = client as unknown as UntypedSupabaseClient;
  const { data, error } = await db.from("commerce_orders").select("id, order_number").in("id", orderIds);
  if (error) throw error;
  for (const row of (data ?? []) as Array<{ id?: unknown; order_number?: unknown }>) {
    if (typeof row.id === "string" && typeof row.order_number === "string" && row.order_number) {
      map.set(row.id, row.order_number);
    }
  }
  return map;
}

function providerResponseText(value: unknown, key: "outboxEventId" | "orderId"): string | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const raw = (value as Record<string, unknown>)[key];
  return typeof raw === "string" && raw ? normalizeOrderSearch(raw) : null;
}

function recipientLabel(send: EmailSendWithTesterRow, orderNumber: string | null, aggregateId: string | null): string | null {
  if (send.testers) return null;
  const orderRef = orderNumber ?? aggregateId;
  if (orderRef) return `Zamówienie ${orderRef}`;
  return send.source === "outbox-dispatch" ? "Klient commerce" : null;
}

function isCommerceOrderDelivery(row: DeliveryRow): boolean {
  return row.aggregate_type === "commerce_order";
}

function normalizeOrderSearch(value: string): string {
  return value.startsWith("order_") ? value.slice("order_".length) : value;
}

function isUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}

function addId(ids: Set<string>, value: unknown): void {
  if (typeof value === "string" && value) ids.add(value);
}

function isString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}
