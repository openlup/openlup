import { describe, expect, it, vi } from "vitest";
import {
  evaluateLifecycleEvidence,
  lifecycleEvidenceSignature,
  readExistingLifecycleCanaryOrderId,
  readLifecycleEvidence,
  safeguardLifecycleCanary,
  type LifecycleEvidenceAdmin,
  type LifecycleEvidenceQuery,
  type LifecycleEvidenceRpcAdmin,
  type LifecycleEvidenceSnapshot,
} from "./lifecycleEvidence.ts";
import { abortLifecycleCanaryBeforeDispatch } from "./abort.ts";

const ORDER = "order-1";
const FULFILLMENT = "fulfillment-1";
const INVOICE = "invoice-1";
const NOW = "2026-07-16T12:00:00.000Z";

function validSnapshot(): LifecycleEvidenceSnapshot {
  const communications = [
    communication("comm-paid", "commerce-order-paid", "send-paid", "resend-paid", "sent"),
    communication("comm-dispatched", "commerce-shipment-dispatched", "send-dispatched", "resend-dispatched", "sent"),
    communication("comm-invoice", "commerce-invoice-document", "send-invoice", "resend-invoice", "delivered"),
    communication("comm-delivered", "commerce-shipment-delivered", "send-delivered", "resend-delivered", "sent"),
  ];
  return {
    orderId: ORDER,
    order: [{ id: ORDER, status: "fulfilled" }],
    paymentIntents: [{ id: "payment-intent-1", order_id: ORDER, status: "succeeded", provider_payment_id: "pi_1" }],
    fulfillments: [{ id: FULFILLMENT, order_id: ORDER, status: "delivered", provider_kind: "omnipack", handed_over_at: NOW, delivered_at: NOW }],
    dispatchRefs: [{ id: "dispatch-1", fulfillment_order_id: FULFILLMENT, provider_kind: "omnipack", provider_order_id: "provider-order-1", status: "created", request_idempotency_key: "dispatch-key" }],
    providerAttempts: [
      { id: "attempt-accept", fulfillment_order_id: FULFILLMENT, provider_kind: "omnipack", status: "succeeded", idempotency_key: "attempt-accept", evidence_kind: "provider_acceptance" },
      { id: "attempt-label", fulfillment_order_id: FULFILLMENT, provider_kind: "omnipack", status: "succeeded", idempotency_key: "attempt-label", evidence_kind: "dispatch_label_ack" },
    ],
    operations: [
      operation("op-created", "created", "created-key"),
      operation("op-label", "label_created", "label-key"),
      operation("op-packed", "packed", "packed-key", { source: "provider_stock_consumed" }),
      operation("op-handoff", "handed_over", "handoff-key"),
      operation("op-transit", "tracking_event_recorded", "tracking-transit", { status: "in_transit" }),
      operation("op-delivered", "tracking_event_recorded", "tracking-delivered", { status: "delivered" }),
    ],
    reservationIds: ["reservation-1", "reservation-2"],
    reservations: [
      { id: "reservation-1", status: "consumed", consumed_at: NOW },
      { id: "reservation-2", status: "consumed", consumed_at: NOW },
    ],
    stockMovements: [
      { id: "movement-1", reservation_id: "reservation-1", movement_type: "reservation_consumed", idempotency_key: "consume-1" },
      { id: "movement-2", reservation_id: "reservation-2", movement_type: "reservation_consumed", idempotency_key: "consume-2" },
    ],
    trackingRefs: [{ id: "tracking-1", order_id: ORDER, provider_kind: "omnipack", provider_tracking_id: "tracking-number-1", active: true }],
    invoices: [{ id: INVOICE, order_id: ORDER, status: "issued", correction_of_invoice_id: null, provider_invoice_id: "provider-invoice-1", provider_pdf_ref: null, email_status: "sent" }],
    issueOutbox: [{ id: "issue-1", invoice_id: INVOICE, provider_kind: "fakturownia", status: "succeeded" }],
    deliveryOutbox: [{ id: "delivery-1", invoice_id: INVOICE, status: "succeeded", delivery_kind: "provider_email", delivery_provider: "resend", provider_message_id: "resend-invoice", email_send_id: "send-invoice", idempotency_key: "invoice-delivery-key" }],
    outboxEvents: [
      outbox("event-paid", ORDER, "commerce.order.paid"),
      outbox("event-paid-email", ORDER, "commerce.order.paid.email"),
      outbox("event-handoff", FULFILLMENT, "commerce.fulfillment.handed_over"),
      outbox("event-dispatched", ORDER, "commerce.shipment.dispatched"),
      outbox("event-delivered", ORDER, "commerce.shipment.delivered"),
    ],
    communications,
    emailSends: communications.filter((row) => row.email_send_id).map((row) => ({ id: row.email_send_id, template_slug: row.template_slug, status: row.status, resend_id: row.provider_message_id, source: "outbox", idempotency_key: `send:${row.id}` })),
  };
}

function operation(id: string, operation_type: string, idempotency_key: string, extra: Record<string, unknown> = {}) {
  return { id, fulfillment_order_id: FULFILLMENT, operation_type, idempotency_key, ...extra };
}

function outbox(id: string, aggregate_id: string, event_type: string) {
  return { id, aggregate_id, event_type, idempotency_key: `${event_type}:${id}`, status: "processed", processed_at: NOW, skipped: "" };
}

function communication(id: string, template_slug: string, email_send_id: string, provider_message_id: string, status: string) {
  return { id, aggregate_id: ORDER, template_slug, trigger_event: template_slug, status, email_send_id, provider_kind: "resend", provider_message_id, delivered_at: status === "delivered" ? NOW : null, dedupe_key: `dedupe:${id}` };
}

function mutate(change: (snapshot: LifecycleEvidenceSnapshot) => void): string[] {
  const snapshot = structuredClone(validSnapshot());
  change(snapshot);
  return evaluateLifecycleEvidence(snapshot, { orderId: ORDER, fulfillmentId: FULFILLMENT }).failureCodes;
}

describe("lifecycle evidence evaluator", () => {
  it("accepts the complete paid-to-delivered lifecycle including the local delivered email", () => {
    expect(evaluateLifecycleEvidence(validSnapshot(), { orderId: ORDER, fulfillmentId: FULFILLMENT, deliveredAt: NOW })).toMatchObject({ ok: true, failureCodes: [] });
  });

  it("proves the B2C PDF through the linked delivered Resend evidence without provider sync metadata", () => {
    const snapshot = validSnapshot();
    expect(snapshot.invoices[0].provider_pdf_ref).toBeNull();
    expect(evaluateLifecycleEvidence(snapshot, { orderId: ORDER })).toMatchObject({ ok: true, failureCodes: [] });
  });

  it.each([
    ["missing payment", (s: LifecycleEvidenceSnapshot) => { s.paymentIntents = []; }, "payment_not_unique_succeeded"],
    ["missing provider payment id", (s: LifecycleEvidenceSnapshot) => { s.paymentIntents[0].provider_payment_id = null; }, "payment_provider_id_missing"],
    ["duplicate provider acceptance", (s: LifecycleEvidenceSnapshot) => { s.providerAttempts.push({ ...s.providerAttempts[0], id: "attempt-accept-2", idempotency_key: "attempt-accept-2" }); }, "provider_acceptance_attempt_not_unique"],
    ["missing provider label attempt", (s: LifecycleEvidenceSnapshot) => { s.providerAttempts = s.providerAttempts.filter((row) => row.evidence_kind !== "dispatch_label_ack"); }, "provider_label_ack_attempt_not_unique"],
    ["missing label ack", (s: LifecycleEvidenceSnapshot) => { s.operations = s.operations.filter((row) => row.operation_type !== "label_created"); }, "label_ack_not_unique"],
    ["duplicate label ack", (s: LifecycleEvidenceSnapshot) => { s.operations.push(operation("op-label-2", "label_created", "label-key-2")); }, "label_ack_not_unique"],
    ["missing provider stock op", (s: LifecycleEvidenceSnapshot) => { s.operations = s.operations.filter((row) => row.operation_type !== "packed"); }, "provider_stock_op_not_unique"],
    ["duplicate stock movement", (s: LifecycleEvidenceSnapshot) => { s.stockMovements.push({ ...s.stockMovements[0], id: "movement-extra", idempotency_key: "consume-extra" }); }, "stock_movements_not_exactly_once"],
    ["missing handoff", (s: LifecycleEvidenceSnapshot) => { s.operations = s.operations.filter((row) => row.operation_type !== "handed_over"); }, "handoff_not_unique"],
    ["missing final tracking", (s: LifecycleEvidenceSnapshot) => { s.operations = s.operations.filter((row) => row.status !== "delivered"); }, "delivered_tracking_not_unique"],
    ["duplicate tracking occurrence key", (s: LifecycleEvidenceSnapshot) => { s.operations.find((row) => row.status === "delivered")!.idempotency_key = "tracking-transit"; }, "tracking_occurrences_invalid"],
    ["provider id used as tracking", (s: LifecycleEvidenceSnapshot) => { s.trackingRefs[0].provider_tracking_id = "provider-order-1"; }, "tracking_ref_invalid"],
    ["missing provider invoice id", (s: LifecycleEvidenceSnapshot) => { s.invoices[0].provider_invoice_id = null; }, "invoice_not_issued"],
    ["missing invoice delivery", (s: LifecycleEvidenceSnapshot) => { s.deliveryOutbox = []; }, "invoice_delivery_outbox_not_succeeded"],
    ["missing invoice communication", (s: LifecycleEvidenceSnapshot) => { s.communications = s.communications.filter((row) => row.template_slug !== "commerce-invoice-document"); }, "communication_commerce-invoice-document_not_unique"],
    ["missing delivered communication", (s: LifecycleEvidenceSnapshot) => { s.communications = s.communications.filter((row) => row.template_slug !== "commerce-shipment-delivered"); }, "communication_commerce-shipment-delivered_not_unique"],
    ["delivered event skipped", (s: LifecycleEvidenceSnapshot) => { s.outboxEvents.find((row) => row.event_type === "commerce.shipment.delivered")!.skipped = "carrier_owns_delivered:omnipack"; }, "delivered_outbox_skipped"],
    ["invoice communication not delivered", (s: LifecycleEvidenceSnapshot) => { s.communications.find((row) => row.template_slug === "commerce-invoice-document")!.status = "sent"; }, "communication_commerce-invoice-document_not_complete"],
    ["invoice delivery not linked to communication", (s: LifecycleEvidenceSnapshot) => { s.deliveryOutbox[0].provider_message_id = "other-resend-id"; }, "invoice_delivery_communication_link_invalid"],
    ["communication send not successful", (s: LifecycleEvidenceSnapshot) => { s.emailSends.find((row) => row.template_slug === "commerce-order-paid")!.status = "failed"; }, "communication_email_send_links_invalid"],
  ])("rejects %s", (_label, change, code) => {
    expect(mutate(change)).toContain(code);
  });

  it("requires delivered_at to equal the provider occurrence when supplied", () => {
    expect(evaluateLifecycleEvidence(validSnapshot(), { orderId: ORDER, deliveredAt: "2026-07-16T12:00:01.000Z" }).failureCodes).toContain("fulfillment_delivered_at_mismatch");
  });

  it("keeps a stable replay signature but detects any new evidence identity", () => {
    const before = validSnapshot();
    const reordered = structuredClone(before);
    reordered.operations.reverse();
    reordered.outboxEvents.reverse();
    expect(lifecycleEvidenceSignature(reordered)).toBe(lifecycleEvidenceSignature(before));

    const converged = structuredClone(before);
    converged.order[0].status = "fulfilled";
    converged.communications.find((row) => row.template_slug === "commerce-order-paid")!.status = "delivered";
    converged.emailSends.find((row) => row.template_slug === "commerce-order-paid")!.status = "delivered";
    expect(lifecycleEvidenceSignature(converged)).toBe(lifecycleEvidenceSignature(before));

    const replayCreatedDuplicate = structuredClone(before);
    replayCreatedDuplicate.providerAttempts.push({ ...replayCreatedDuplicate.providerAttempts[0], id: "attempt-duplicate" });
    expect(lifecycleEvidenceSignature(replayCreatedDuplicate)).not.toBe(lifecycleEvidenceSignature(before));
  });
});

describe("lifecycle evidence reader", () => {
  it("uses order-correlated structural reads and never selects PII", async () => {
    const snapshot = validSnapshot();
    const dataByTable: Record<string, unknown[]> = {
      commerce_orders: snapshot.order,
      commerce_payment_intents: snapshot.paymentIntents,
      commerce_fulfillment_orders: snapshot.fulfillments,
      omnipack_dispatch_refs: snapshot.dispatchRefs,
      commerce_fulfillment_provider_attempts: snapshot.providerAttempts,
      commerce_fulfillment_operations: snapshot.operations,
      commerce_fulfillment_order_lines: [{ inventory_reservation_ids: snapshot.reservationIds }],
      inventory_reservations: snapshot.reservations,
      inventory_stock_movements: snapshot.stockMovements,
      shipment_external_refs: snapshot.trackingRefs,
      accounting_invoices: snapshot.invoices,
      accounting_invoice_issue_outbox: snapshot.issueOutbox,
      accounting_invoice_delivery_outbox: snapshot.deliveryOutbox,
      outbox_events: snapshot.outboxEvents,
      communication_email_deliveries: snapshot.communications,
      email_sends: snapshot.emailSends,
    };
    const selected: string[] = [];
    const read = await readLifecycleEvidence(fakeAdmin(dataByTable, selected), ORDER);
    expect(evaluateLifecycleEvidence(read, { orderId: ORDER }).ok).toBe(true);
    expect(selected.join(",")).not.toMatch(/recipient_email|buyer_snapshot|shipping_address|raw_event|request_payload|response_payload/i);
  });

  it("fails closed on a PostgREST query error", async () => {
    await expect(readLifecycleEvidence(fakeAdmin({}, [], "commerce_payment_intents"), ORDER)).rejects.toThrow(
      "lifecycle_evidence_read_failed:commerce_payment_intents:boom",
    );
  });

  it("resumes the same checkout identity and places an idempotent safeguard hold", async () => {
    const selected: string[] = [];
    const existing = await readExistingLifecycleCanaryOrderId(fakeAdmin({
      commerce_idempotency_keys: [{ order_id: ORDER }],
    }, selected), "omnipack-e2e-inpost-run-1");
    expect(existing).toBe(ORDER);
    expect(selected).toEqual(["order_id:metadata->>orderId"]);

    const calls: Array<{ functionName: string; args: Record<string, unknown> }> = [];
    const rpcAdmin: LifecycleEvidenceRpcAdmin = {
      rpc(functionName, args) {
        calls.push({ functionName, args });
        return Promise.resolve({ data: { ok: true }, error: null });
      },
    };
    await safeguardLifecycleCanary(rpcAdmin, { runId: "lifecycle-run-1", orderId: ORDER, fulfillmentOrderId: FULFILLMENT, reason: "scope_changed" });
    expect(calls).toEqual([{
      functionName: "commerce_fulfillment_record_provider_exception",
      args: expect.objectContaining({
        p_idempotency_key: "omnipack-e2e:lifecycle-run-1:abort-hold",
        p_order_id: ORDER,
        p_reason: "scope_changed",
        p_metadata: expect.objectContaining({ fulfillmentOrderId: FULFILLMENT }),
      }),
    }]);
  });

  it("safeguards a resumed catalog abort before returning failure", async () => {
    const safeguard = vi.fn().mockResolvedValue(undefined);
    const result = await abortLifecycleCanaryBeforeDispatch({ rpc: vi.fn() }, {
      runId: "lifecycle-run-1",
      caseId: "inpost-locker",
      failureCode: "catalog_variant_missing",
      orderId: ORDER,
      fulfillmentOrderId: FULFILLMENT,
    }, safeguard);
    expect(safeguard).toHaveBeenCalledWith(expect.anything(), {
      runId: "lifecycle-run-1",
      orderId: ORDER,
      fulfillmentOrderId: FULFILLMENT,
      reason: "e2e_catalog_variant_missing",
    });
    expect(result).toMatchObject({ canarySafeguarded: true, failureCodes: ["catalog_variant_missing"] });
  });
});

function fakeAdmin(dataByTable: Record<string, unknown[]>, selected: string[], failingTable?: string): LifecycleEvidenceAdmin {
  return {
    from(table: string) {
      let columns = "";
      const query: LifecycleEvidenceQuery = {
        select(value) { columns = value; selected.push(value); return query; },
        eq() { return query; },
        in() { return query; },
        then(resolve, reject) {
          return Promise.resolve(table === failingTable
            ? { data: null, error: { message: "boom" } }
            : { data: dataByTable[table] ?? [], error: null })
            .then(resolve, reject);
        },
      };
      void columns;
      return query;
    },
  };
}
