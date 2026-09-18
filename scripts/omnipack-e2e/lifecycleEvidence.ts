import { createHash } from "node:crypto";
import type { SupabaseClient } from "@supabase/supabase-js";
import { customerStepFromSignals } from "../../src/domains/fulfillment/statusMap.ts";
import { getCommerceOmsOrderDetail } from "../../server/adapters/supabase/commerce/oms/readQueries.ts";
import { readCustomerOrderDetail } from "../../server/adapters/supabase/customerOrderHistoryReadModels.ts";
import { createSupabaseCustomerOrderHistoryReadStore } from "../../server/adapters/supabase/customerOrderHistoryReadStore.ts";
import {
  createSupabaseOmnipackReconciliationPort,
  type OmnipackReconciliationSupabaseClient,
} from "../../server/adapters/supabase/omnipackReconciliationPort.ts";

type QueryError = { code?: string; message?: string } | null;
type QueryResult = { data: unknown; error: QueryError };

export interface LifecycleEvidenceQuery extends PromiseLike<QueryResult> {
  select(columns: string): LifecycleEvidenceQuery;
  eq(column: string, value: unknown): LifecycleEvidenceQuery;
  in(column: string, values: unknown[]): LifecycleEvidenceQuery;
}

export interface LifecycleEvidenceAdmin {
  from(table: string): LifecycleEvidenceQuery;
}

export interface LifecycleEvidenceRpcAdmin {
  rpc(functionName: string, args: Record<string, unknown>): PromiseLike<QueryResult>;
}

type Row = Record<string, unknown>;

export interface LifecycleEvidenceSnapshot {
  orderId: string;
  order: Row[];
  paymentIntents: Row[];
  fulfillments: Row[];
  dispatchRefs: Row[];
  providerAttempts: Row[];
  operations: Row[];
  reservationIds: string[];
  reservations: Row[];
  stockMovements: Row[];
  trackingRefs: Row[];
  invoices: Row[];
  issueOutbox: Row[];
  deliveryOutbox: Row[];
  outboxEvents: Row[];
  communications: Row[];
  emailSends: Row[];
}

export interface LifecycleEvidenceExpected {
  orderId: string;
  fulfillmentId?: string;
  deliveredAt?: string;
}

export interface LifecycleEvidenceEvaluation {
  ok: boolean;
  failureCodes: string[];
  signature: string;
}

async function rows(
  admin: LifecycleEvidenceAdmin,
  table: string,
  columns: string,
  filter: (query: LifecycleEvidenceQuery) => LifecycleEvidenceQuery,
): Promise<Row[]> {
  const result = await filter(admin.from(table).select(columns));
  if (result.error) {
    throw new Error(`lifecycle_evidence_read_failed:${table}:${result.error.message ?? result.error.code ?? "query_failed"}`);
  }
  if (!Array.isArray(result.data)) throw new Error(`lifecycle_evidence_read_failed:${table}:expected_rows`);
  return result.data as Row[];
}

function text(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function sameInstant(left: unknown, right: string): boolean {
  const leftMs = Date.parse(text(left));
  const rightMs = Date.parse(right);
  return Number.isFinite(leftMs) && Number.isFinite(rightMs) && leftMs === rightMs;
}

function idsFromLines(lines: Row[]): string[] {
  return [...new Set(lines.flatMap((row) => Array.isArray(row.inventory_reservation_ids)
    ? row.inventory_reservation_ids.filter((id): id is string => typeof id === "string" && id.length > 0)
    : []))].sort();
}

export async function readLifecycleEvidence(
  admin: LifecycleEvidenceAdmin,
  orderId: string,
): Promise<LifecycleEvidenceSnapshot> {
  const byOrder = (query: LifecycleEvidenceQuery) => query.eq("order_id", orderId);
  const order = await rows(admin, "commerce_orders", "id,order_number,client_id,status", (query) => query.eq("id", orderId));
  const paymentIntents = await rows(admin, "commerce_payment_intents", "id,order_id,status,provider_payment_id", byOrder);
  const fulfillments = await rows(admin, "commerce_fulfillment_orders", "id,order_id,status,provider_kind,handed_over_at,delivered_at", byOrder);
  const fulfillmentIds = fulfillments.map((row) => text(row.id)).filter(Boolean);
  const byFulfillment = (query: LifecycleEvidenceQuery) => query.in("fulfillment_order_id", fulfillmentIds);
  const dispatchRefs = fulfillmentIds.length ? await rows(admin, "omnipack_dispatch_refs", "id,fulfillment_order_id,provider_kind,provider_order_id,status,request_idempotency_key", byFulfillment) : [];
  const providerAttempts = fulfillmentIds.length ? await rows(admin, "commerce_fulfillment_provider_attempts", "id,fulfillment_order_id,provider_kind,status,idempotency_key,evidence_kind:metadata->>evidenceKind", byFulfillment) : [];
  const operations = fulfillmentIds.length ? await rows(admin, "commerce_fulfillment_operations", "id,fulfillment_order_id,operation_type,idempotency_key,source:payload->>source,status:payload->>status", byFulfillment) : [];
  const lines = fulfillmentIds.length ? await rows(admin, "commerce_fulfillment_order_lines", "inventory_reservation_ids", byFulfillment) : [];
  const reservationIds = idsFromLines(lines);
  const reservations = reservationIds.length ? await rows(admin, "inventory_reservations", "id,status,consumed_at", (query) => query.in("id", reservationIds)) : [];
  const stockMovements = reservationIds.length ? await rows(admin, "inventory_stock_movements", "id,reservation_id,movement_type,idempotency_key", (query) => query.in("reservation_id", reservationIds)) : [];
  const trackingRefs = await rows(admin, "shipment_external_refs", "id,order_id,provider_kind,provider_tracking_id,active", byOrder);
  const invoices = await rows(admin, "accounting_invoices", "id,order_id,status,correction_of_invoice_id,provider_invoice_id,provider_pdf_ref,email_status", byOrder);
  const invoiceIds = invoices.map((row) => text(row.id)).filter(Boolean);
  const byInvoice = (query: LifecycleEvidenceQuery) => query.in("invoice_id", invoiceIds);
  const issueOutbox = invoiceIds.length ? await rows(admin, "accounting_invoice_issue_outbox", "id,invoice_id,provider_kind,status", byInvoice) : [];
  const deliveryOutbox = invoiceIds.length ? await rows(admin, "accounting_invoice_delivery_outbox", "id,invoice_id,status,delivery_kind,delivery_provider:metadata->>deliveryProvider,provider_message_id:metadata->>providerMessageId,email_send_id:metadata->>emailSendId,idempotency_key:metadata->>idempotencyKey", byInvoice) : [];
  const eventTypes = ["commerce.order.paid", "commerce.order.paid.email", "commerce.fulfillment.handed_over", "commerce.shipment.dispatched", "commerce.shipment.delivered"];
  const aggregateIds = [orderId, ...fulfillmentIds];
  const outboxEvents = await rows(admin, "outbox_events", "id,aggregate_id,event_type,idempotency_key,status,processed_at,skipped:metadata->>skipped", (query) => query.in("aggregate_id", aggregateIds).in("event_type", eventTypes));
  const communications = await rows(admin, "communication_email_deliveries", "id,aggregate_id,template_slug,trigger_event,status,email_send_id,provider_kind,provider_message_id,delivered_at,dedupe_key,last_error_code", (query) => query.eq("aggregate_type", "commerce_order").eq("aggregate_id", orderId));
  const emailSendIds = communications.map((row) => text(row.email_send_id)).filter(Boolean);
  const emailSends = emailSendIds.length ? await rows(admin, "email_sends", "id,template_slug,status,resend_id,source,idempotency_key:provider_response->>idempotencyKey", (query) => query.in("id", emailSendIds)) : [];
  return { orderId, order, paymentIntents, fulfillments, dispatchRefs, providerAttempts, operations, reservationIds, reservations, stockMovements, trackingRefs, invoices, issueOutbox, deliveryOutbox, outboxEvents, communications, emailSends };
}

export async function readExistingLifecycleCanaryOrderId(
  admin: LifecycleEvidenceAdmin,
  idempotencyKey: string,
): Promise<string | null> {
  const matches = await rows(admin, "commerce_idempotency_keys", "order_id:metadata->>orderId", (query) => query
    .eq("scope", "commerce.checkout_order_finalize")
    .eq("idempotency_key", idempotencyKey)
    .eq("status", "completed"));
  if (matches.length > 1) throw new Error("lifecycle_canary_identity_not_unique");
  return text(matches[0]?.order_id) || null;
}

export async function safeguardLifecycleCanary(
  admin: LifecycleEvidenceRpcAdmin,
  input: { runId: string; orderId: string; fulfillmentOrderId: string; reason: string },
): Promise<void> {
  const port = createSupabaseOmnipackReconciliationPort(
    admin as unknown as OmnipackReconciliationSupabaseClient,
  );
  await port.recordProviderException({
    idempotencyKey: `omnipack-e2e:${input.runId}:abort-hold`,
    orderId: input.orderId,
    fulfillmentOrderId: input.fulfillmentOrderId,
    reason: input.reason,
    // This canary hold comes from an e2e safety abort, not a provider status, so
    // it carries no provider occurrence. The auto-heal predicate keys on the
    // newest `exception` status evidence, which this path never writes — so the
    // canary hold stays put until a human closes it, which is what we want.
    providerStatus: input.reason,
    occurredAt: null,
  });
}

function identityRows(rowsToMap: Row[], fields: string[]): string[] {
  const scalar = (value: unknown) => value == null ? "" : typeof value === "string" ? value.trim() : String(value);
  return rowsToMap.map((row) => fields.map((field) => scalar(row[field])).join("|")).sort();
}

export function lifecycleEvidenceIdentity(snapshot: LifecycleEvidenceSnapshot): Record<string, string[]> {
  return {
    order: identityRows(snapshot.order, ["id", "order_number", "client_id"]),
    paymentIntents: identityRows(snapshot.paymentIntents, ["id", "provider_payment_id"]),
    fulfillments: identityRows(snapshot.fulfillments, ["id", "provider_kind"]),
    dispatchRefs: identityRows(snapshot.dispatchRefs, ["id", "provider_order_id", "request_idempotency_key"]),
    providerAttempts: identityRows(snapshot.providerAttempts, ["id", "idempotency_key", "evidence_kind"]),
    operations: identityRows(snapshot.operations, ["id", "operation_type", "idempotency_key"]),
    reservationIds: [...snapshot.reservationIds].sort(),
    reservations: identityRows(snapshot.reservations, ["id"]),
    stockMovements: identityRows(snapshot.stockMovements, ["id", "reservation_id", "movement_type", "idempotency_key"]),
    trackingRefs: identityRows(snapshot.trackingRefs, ["id", "provider_tracking_id"]),
    invoices: identityRows(snapshot.invoices, ["id", "provider_invoice_id", "provider_pdf_ref"]),
    issueOutbox: identityRows(snapshot.issueOutbox, ["id", "invoice_id"]),
    deliveryOutbox: identityRows(snapshot.deliveryOutbox, ["id", "invoice_id", "provider_message_id", "email_send_id", "idempotency_key"]),
    outboxEvents: identityRows(snapshot.outboxEvents, ["id", "event_type", "idempotency_key"]),
    communications: identityRows(snapshot.communications, ["id", "template_slug", "email_send_id", "provider_message_id", "dedupe_key"]),
    emailSends: identityRows(snapshot.emailSends, ["id", "resend_id", "idempotency_key"]),
  };
}

export function lifecycleEvidenceSignature(snapshot: LifecycleEvidenceSnapshot): string {
  return createHash("sha256").update(JSON.stringify(lifecycleEvidenceIdentity(snapshot))).digest("hex");
}

export async function readProjectionFailureCodes(
  client: SupabaseClient,
  snapshot: LifecycleEvidenceSnapshot,
): Promise<string[]> {
  const order = snapshot.order[0];
  const orderId = text(order?.id);
  const clientId = text(order?.client_id);
  if (!orderId || !clientId) return ["projection_scope_missing"];
  const [oms, customer] = await Promise.all([
    getCommerceOmsOrderDetail(client as never, { orderId }),
    readCustomerOrderDetail(createSupabaseCustomerOrderHistoryReadStore(client, client), clientId, orderId),
  ]);
  const tracking = text(snapshot.trackingRefs.find((row) => row.active === true)?.provider_tracking_id);
  const invoiceId = text(snapshot.invoices.find((row) => row.correction_of_invoice_id == null)?.id);
  const failures: string[] = [];
  if (
    !oms
    || oms.order.fulfillment.status !== "delivered"
    || oms.order.fulfillment.providerKind !== "omnipack"
    || oms.order.fulfillment.providerTrackingId !== tracking
    || !["issued", "accepted"].includes(oms.order.accounting.status)
    || oms.order.accounting.invoiceId !== invoiceId
  ) failures.push("oms_projection_incomplete");
  if (
    !customer
    || customer.order.fulfillmentStatus !== "delivered"
    || customer.order.fulfillment?.status !== "delivered"
    || customer.order.fulfillment?.trackingNumber !== tracking
    || customer.order.invoice?.invoiceId !== invoiceId
    || customer.order.invoice.downloadAvailable !== true
    || !customer.order.invoice.downloadUrl
  ) failures.push("customer_projection_incomplete");
  return failures;
}

export function evaluateLifecycleEvidence(snapshot: LifecycleEvidenceSnapshot, expected: LifecycleEvidenceExpected): LifecycleEvidenceEvaluation {
  const failures = new Set<string>();
  const one = (items: Row[], code: string) => { if (items.length !== 1) failures.add(code); return items[0]; };
  if (snapshot.orderId !== expected.orderId) failures.add("order_scope_mismatch");
  const order = one(snapshot.order, "order_not_unique");
  if (!order || !["paid", "fulfillment_pending", "fulfilled"].includes(text(order.status))) failures.add("order_not_paid");
  const payments = snapshot.paymentIntents.filter((row) => row.status === "succeeded");
  const payment = one(payments, "payment_not_unique_succeeded");
  if (!text(payment?.provider_payment_id)) failures.add("payment_provider_id_missing");
  const fulfillment = one(snapshot.fulfillments, "fulfillment_not_unique");
  if (!fulfillment || fulfillment.status !== "delivered" || fulfillment.provider_kind !== "omnipack") failures.add("fulfillment_not_delivered");
  if (!text(fulfillment?.delivered_at)) failures.add("fulfillment_delivered_at_missing");
  if (expected.deliveredAt && !sameInstant(fulfillment?.delivered_at, expected.deliveredAt)) failures.add("fulfillment_delivered_at_mismatch");
  if (expected.fulfillmentId && fulfillment?.id !== expected.fulfillmentId) failures.add("fulfillment_scope_mismatch");
  if (customerStepFromSignals([text(order?.status), text(fulfillment?.status)]) !== "delivered") failures.add("customer_step_not_delivered");
  const dispatch = one(snapshot.dispatchRefs, "dispatch_ref_not_unique");
  if (!dispatch || dispatch.status !== "created" || dispatch.provider_kind !== "omnipack" || !text(dispatch.provider_order_id)) failures.add("dispatch_not_accepted");
  const succeededAttempts = snapshot.providerAttempts.filter((row) => row.fulfillment_order_id === fulfillment?.id && row.provider_kind === "omnipack" && row.status === "succeeded");
  if (succeededAttempts.length !== 2 || new Set(succeededAttempts.map((row) => text(row.idempotency_key))).size !== 2) failures.add("provider_attempts_not_exactly_once");
  one(succeededAttempts.filter((row) => row.evidence_kind === "provider_acceptance"), "provider_acceptance_attempt_not_unique");
  one(succeededAttempts.filter((row) => row.evidence_kind === "dispatch_label_ack"), "provider_label_ack_attempt_not_unique");
  const ops = (kind: string) => snapshot.operations.filter((row) => row.operation_type === kind);
  one(ops("label_created"), "label_ack_not_unique");
  one(ops("packed").filter((row) => row.source === "provider_stock_consumed"), "provider_stock_op_not_unique");
  one(ops("handed_over"), "handoff_not_unique");
  const trackingOps = ops("tracking_event_recorded");
  if (trackingOps.length < 1 || new Set(trackingOps.map((row) => text(row.idempotency_key))).size !== trackingOps.length) failures.add("tracking_occurrences_invalid");
  one(trackingOps.filter((row) => row.status === "delivered"), "delivered_tracking_not_unique");
  if (!snapshot.reservationIds.length || snapshot.reservations.length !== snapshot.reservationIds.length || snapshot.reservations.some((row) => row.status !== "consumed" || !text(row.consumed_at))) failures.add("reservations_not_consumed");
  const consumed = snapshot.stockMovements.filter((row) => row.movement_type === "reservation_consumed");
  if (consumed.length !== snapshot.reservationIds.length || snapshot.reservationIds.some((id) => consumed.filter((row) => row.reservation_id === id).length !== 1)) failures.add("stock_movements_not_exactly_once");
  const tracking = one(snapshot.trackingRefs.filter((row) => row.active === true && row.provider_kind === "omnipack"), "tracking_ref_not_unique");
  if (!tracking || !text(tracking.provider_tracking_id) || tracking.provider_tracking_id === dispatch?.provider_order_id) failures.add("tracking_ref_invalid");
  const invoice = one(snapshot.invoices.filter((row) => row.correction_of_invoice_id == null), "invoice_not_unique");
  if (!invoice || !["issued", "accepted"].includes(text(invoice.status)) || !text(invoice.provider_invoice_id)) failures.add("invoice_not_issued");
  one(snapshot.issueOutbox.filter((row) => row.invoice_id === invoice?.id && row.status === "succeeded"), "invoice_issue_outbox_not_succeeded");
  const delivery = one(snapshot.deliveryOutbox.filter((row) => row.invoice_id === invoice?.id && row.status === "succeeded"), "invoice_delivery_outbox_not_succeeded");
  if (!delivery || delivery.delivery_kind !== "provider_email" || delivery.delivery_provider !== "resend" || !text(delivery.provider_message_id) || !text(delivery.email_send_id) || !text(delivery.idempotency_key)) failures.add("invoice_delivery_resend_evidence_missing");
  const event = (kind: string, aggregateId: unknown) => snapshot.outboxEvents.filter((row) => row.event_type === kind && row.aggregate_id === aggregateId && row.status === "processed" && text(row.processed_at));
  for (const [kind, aggregateId, code] of [
    ["commerce.order.paid", expected.orderId, "order_paid_outbox_not_processed"],
    ["commerce.order.paid.email", expected.orderId, "order_paid_email_outbox_not_processed"],
    ["commerce.fulfillment.handed_over", fulfillment?.id, "handoff_outbox_not_processed"],
    ["commerce.shipment.dispatched", expected.orderId, "dispatched_outbox_not_processed"],
  ] as const) one(event(kind, aggregateId), code);
  const deliveredEvent = one(event("commerce.shipment.delivered", expected.orderId), "delivered_outbox_not_processed");
  if (text(deliveredEvent?.skipped)) failures.add("delivered_outbox_skipped");
  const required = [["commerce-order-paid", false], ["commerce-shipment-dispatched", false], ["commerce-shipment-delivered", false], ["commerce-invoice-document", true]] as const;
  const requiredRows = required.flatMap(([slug, mustDeliver]) => {
    const matches = snapshot.communications.filter((row) => row.template_slug === slug);
    const row = one(matches, `communication_${slug}_not_unique`);
    if (!row || row.provider_kind !== "resend" || !text(row.email_send_id) || !text(row.provider_message_id) || (mustDeliver ? row.status !== "delivered" || !text(row.delivered_at) : !["sent", "delivered"].includes(text(row.status)))) failures.add(`communication_${slug}_not_complete`);
    return row ? [row] : [];
  });
  const invoiceCommunication = requiredRows.find((row) => row.template_slug === "commerce-invoice-document");
  if (delivery && invoiceCommunication && (delivery.email_send_id !== invoiceCommunication.email_send_id || delivery.provider_message_id !== invoiceCommunication.provider_message_id)) failures.add("invoice_delivery_communication_link_invalid");
  const sendIds = requiredRows.map((row) => text(row.email_send_id));
  if (new Set(sendIds).size !== required.length || sendIds.some((id) => snapshot.emailSends.filter((row) => row.id === id && ["sent", "delivered"].includes(text(row.status)) && text(row.resend_id) === text(requiredRows.find((item) => item.email_send_id === id)?.provider_message_id)).length !== 1)) failures.add("communication_email_send_links_invalid");
  return { ok: failures.size === 0, failureCodes: [...failures].sort(), signature: lifecycleEvidenceSignature(snapshot) };
}
