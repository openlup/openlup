import { describe, expect, it, vi } from "vitest";
import { createSupabaseAccountingControlPort } from "./accountingControl.js";

describe("supabase accounting control port", () => {
  it("maps policy-approved invoice issue requests to the v2 RPC", async () => {
    const rpc = vi.fn(async () => ({
      data: { invoice: invoiceSummary(), replayed: false },
      error: null,
    }));
    const port = createSupabaseAccountingControlPort({ rpc });

    await port.requestInvoiceIssue(issueRequest());

    expect(rpc).toHaveBeenCalledWith("accounting_invoice_issue_request_v2", {
      p_idempotency_key: "invoice-issue-123",
      p_order_id: ORDER_ID,
      p_invoice_ref: "INV/2026/001",
      p_document_type: "b2b_invoice",
      p_buyer_kind: "business",
      p_ksef_requirement: "required",
      p_policy_version: "accounting-approved-2026-06",
      p_policy_approval_id: POLICY_ID,
      p_buyer_snapshot: { taxId: "5250000000" },
      p_order_snapshot: { orderRef: "order_123" },
      p_tax_snapshot: { vatRateBps: 800 },
      p_lines_snapshot: [{ sku: "OPENLUP", grossMinor: 1080 }],
      p_total_net_cents: 1000,
      p_total_gross_cents: 1080,
      p_provider_kind: "fakturownia",
    });
  });

  it("records provider sync evidence with KSeF refs", async () => {
    const rpc = vi.fn(async () => ({ data: { eventId: EVENT_ID, replayed: false }, error: null }));
    const port = createSupabaseAccountingControlPort({ rpc });

    await port.recordProviderSyncEvent({
      idempotencyKey: "sync-event-123",
      invoiceId: INVOICE_ID,
      providerKind: "fakturownia",
      providerEventId: "fv-event-1",
      eventType: "ksef.accepted",
      providerInvoiceId: "fv-1",
      providerInvoiceNumber: "1/06/2026",
      ksefNumber: "KSeF-123",
      ksefStatus: "accepted",
      statusSource: "provider_api",
      providerPdfRef: "pdf:fv-1",
      providerXmlRef: "xml:fv-1",
      providerUpoRef: "upo:fv-1",
      observedAt: "2026-06-06T10:05:00+02:00",
      payloadHash: "sha256:abc123",
      payload: { safe: true },
    });

    expect(rpc).toHaveBeenCalledWith("accounting_record_provider_sync_event", {
      p_idempotency_key: "sync-event-123",
      p_invoice_id: INVOICE_ID,
      p_provider_kind: "fakturownia",
      p_provider_event_id: "fv-event-1",
      p_event_type: "ksef.accepted",
      p_provider_invoice_id: "fv-1",
      p_provider_invoice_number: "1/06/2026",
      p_ksef_number: "KSeF-123",
      p_ksef_status: "accepted",
      p_status_source: "provider_api",
      p_provider_pdf_ref: "pdf:fv-1",
      p_provider_xml_ref: "xml:fv-1",
      p_provider_upo_ref: "upo:fv-1",
      p_observed_at: "2026-06-06T10:05:00+02:00",
      p_payload_hash: "sha256:abc123",
      p_payload: { safe: true },
    });
  });

  it("records PSP settlement evidence and links invoices", async () => {
    const rpc = vi.fn(async () => ({ data: { settlementItemId: SETTLEMENT_ID, replayed: false }, error: null }));
    const port = createSupabaseAccountingControlPort({ rpc });

    await port.recordPaymentSettlement({
      idempotencyKey: "settlement-123",
      providerKind: "stripe",
      providerBatchId: "po_1",
      providerPaymentId: "pi_1",
      paymentIntentId: PAYMENT_INTENT_ID,
      paymentId: PAYMENT_ID,
      invoiceId: INVOICE_ID,
      grossMinor: 1000,
      feeMinor: 29,
      netMinor: 971,
      currency: "PLN",
      status: "matched",
      bankReceivedAt: "2026-06-07T10:00:00+02:00",
      evidence: { payout: "po_1" },
    });

    expect(rpc).toHaveBeenCalledWith("accounting_record_payment_settlement", {
      p_idempotency_key: "settlement-123",
      p_provider_kind: "stripe",
      p_provider_batch_id: "po_1",
      p_provider_payment_id: "pi_1",
      p_payment_intent_id: PAYMENT_INTENT_ID,
      p_payment_id: PAYMENT_ID,
      p_invoice_id: INVOICE_ID,
      p_gross_cents: 1000,
      p_fee_cents: 29,
      p_net_cents: 971,
      p_currency: "PLN",
      p_status: "matched",
      p_bank_received_at: "2026-06-07T10:00:00+02:00",
      p_evidence: { payout: "po_1" },
    });
  });
});

const ORDER_ID = "22222222-2222-4222-8222-222222222222";
const POLICY_ID = "33333333-3333-4333-8333-333333333333";
const INVOICE_ID = "99999999-9999-4999-8999-999999999999";
const EVENT_ID = "88888888-8888-4888-8888-888888888888";
const SETTLEMENT_ID = "77777777-7777-4777-8777-777777777777";
const PAYMENT_INTENT_ID = "55555555-5555-4555-8555-555555555555";
const PAYMENT_ID = "66666666-6666-4666-8666-666666666666";

function issueRequest() {
  return {
    idempotencyKey: "invoice-issue-123",
    orderId: ORDER_ID,
    invoiceRef: "INV/2026/001",
    providerKind: "fakturownia",
    policyApprovalId: POLICY_ID,
    policy: {
      documentType: "b2b_invoice" as const,
      buyerKind: "business" as const,
      ksefRequirement: "required" as const,
      policyVersion: "accounting-approved-2026-06",
      approvedBy: "11111111-1111-4111-8111-111111111111",
      approvedAt: "2026-06-06T10:00:00+02:00",
      rationale: "Business invoices go through KSeF.",
    },
    buyerSnapshot: { taxId: "5250000000" },
    orderSnapshot: { orderRef: "order_123" },
    taxSnapshot: { vatRateBps: 800 },
    linesSnapshot: [{ sku: "OPENLUP", grossMinor: 1080 }],
    totalNetMinor: 1000,
    totalGrossMinor: 1080,
  };
}

function invoiceSummary() {
  return {
    id: INVOICE_ID,
    orderId: ORDER_ID,
    invoiceRef: "INV/2026/001",
    status: "issue_requested",
    documentType: "b2b_invoice",
    buyerKind: "business",
    ksefRequirement: "required",
    ksefStatus: "not_submitted",
    providerKind: "fakturownia",
    providerInvoiceId: null,
    providerInvoiceNumber: null,
    totalGrossMinor: 1080,
    currency: "PLN",
  } as const;
}
