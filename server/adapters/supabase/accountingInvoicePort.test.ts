import { describe, expect, it, vi } from "vitest";
import { AccountingInvoicePersistenceError } from "../../../src/domains/accounting/ports.js";
import { createSupabaseAccountingInvoicePort } from "./accountingInvoicePort.js";

describe("supabase accounting invoice port", () => {
  it("routes paid-order issue requests to the paid-order RPC", async () => {
    const rpc = vi.fn(async () => ({ data: { invoice: { id: "invoice-1" } }, error: null }));
    const port = createSupabaseAccountingInvoicePort({ rpc });

    await expect(port.requestInvoiceIssueFromPaidOrder({
      idempotencyKey: "paid-1",
      orderId: "order-1",
      providerKind: "fakturownia",
    })).resolves.toEqual({ invoice: { id: "invoice-1" } });

    expect(rpc).toHaveBeenCalledWith("accounting_invoice_issue_request_from_paid_order", {
      p_idempotency_key: "paid-1",
      p_order_id: "order-1",
      p_provider_kind: "fakturownia",
    });
  });

  it("passes B2B KSeF email policy to the delivery claim RPC", async () => {
    const rpc = vi.fn(async () => ({ data: [], error: null }));
    const port = createSupabaseAccountingInvoicePort({ rpc });

    await port.claimInvoiceDeliveries(5, { requireKsefAcceptanceForB2b: false, orderId: "order-1" });

    expect(rpc).toHaveBeenCalledWith("accounting_invoice_delivery_outbox_claim", {
      p_limit: 5,
      p_lease_seconds: 300,
      p_require_ksef_acceptance_for_b2b: false,
      p_order_id: "order-1",
    });
  });

  it("routes fenced Resend delivery outcomes to their atomic RPCs", async () => {
    const rpc = vi.fn(async () => ({ data: {}, error: null }));
    const port = createSupabaseAccountingInvoicePort({ rpc });

    await port.markInvoiceDeliverySucceeded({
      outboxId: "outbox-1", claimAttemptCount: 2,
      providerInvoiceId: "provider-invoice-1", providerMessageId: "re_1",
    });
    await port.markInvoiceDeliveryFailed({
      outboxId: "outbox-2", claimAttemptCount: 3,
      providerInvoiceId: "provider-invoice-2",
      error: { code: "accounting_invoice_pdf_empty" }, retrySeconds: 900,
    });
    await port.markInvoiceDeliveryUncertain({
      outboxId: "outbox-3", claimAttemptCount: 4,
      providerInvoiceId: "provider-invoice-3", providerMessageId: "re_maybe",
      error: { code: "invoice_email_local_finalize_uncertain" },
    });

    expect(rpc).toHaveBeenNthCalledWith(1, "accounting_invoice_delivery_outbox_resend_succeed", {
      p_outbox_id: "outbox-1", p_attempt_count: 2,
      p_provider_invoice_id: "provider-invoice-1", p_provider_message_id: "re_1",
    });
    expect(rpc).toHaveBeenNthCalledWith(2, "accounting_invoice_delivery_outbox_resend_fail", {
      p_outbox_id: "outbox-2", p_attempt_count: 3,
      p_provider_invoice_id: "provider-invoice-2",
      p_error: { code: "accounting_invoice_pdf_empty" }, p_retry_seconds: 900,
    });
    expect(rpc).toHaveBeenNthCalledWith(3, "accounting_invoice_delivery_outbox_resend_uncertain", {
      p_outbox_id: "outbox-3", p_attempt_count: 4,
      p_provider_invoice_id: "provider-invoice-3",
      p_error: { code: "invoice_email_local_finalize_uncertain" },
      p_provider_message_id: "re_maybe",
    });
  });

  it("passes targeted order id to the invoice issue claim RPC", async () => {
    const rpc = vi.fn(async () => ({ data: [], error: null }));
    const port = createSupabaseAccountingInvoicePort({ rpc });

    await port.claimInvoiceIssues(3, { orderId: "order-2" });

    expect(rpc).toHaveBeenCalledWith("accounting_invoice_issue_outbox_claim", {
      p_limit: 3,
      p_lease_seconds: 300,
      p_order_id: "order-2",
      p_contract_version: "accounting.issue.v2",
    });
  });

  it("persists canonical mapper disagreement as a terminal block", async () => {
    const rpc = vi.fn(async () => ({ data: { ok: true }, error: null }));
    const port = createSupabaseAccountingInvoicePort({ rpc });

    await port.blockInvoiceIssueCanonicalMapper({
      invoiceId: "invoice-1",
      outboxId: "outbox-1",
      claimAttemptCount: 2,
      code: "accounting_invoice_canonical_allocator_delta_nonzero",
      evidence: { stage: "independent_mapper" },
    });

    expect(rpc).toHaveBeenCalledWith("accounting_invoice_issue_block_canonical_mapper", {
      p_invoice_id: "invoice-1",
      p_outbox_id: "outbox-1",
      p_claim_attempt_count: 2,
      p_code: "accounting_invoice_canonical_allocator_delta_nonzero",
      p_evidence: { stage: "independent_mapper" },
    });
  });

  it("surfaces a rejected canonical mapper fence as a persistence error", async () => {
    const rpc = vi.fn(async () => ({
      data: { ok: false, code: "accounting_invoice_issue_claim_generation_mismatch" },
      error: null,
    }));
    const port = createSupabaseAccountingInvoicePort({ rpc });

    await expect(port.blockInvoiceIssueCanonicalMapper({
      invoiceId: "invoice-1",
      outboxId: "outbox-1",
      claimAttemptCount: 1,
      code: "accounting_invoice_canonical_allocator_delta_nonzero",
      evidence: {},
    })).rejects.toMatchObject({
      causeCode: "accounting_invoice_issue_claim_generation_mismatch",
    });
  });

  it("runs the last payment preflight immediately before provider issue", async () => {
    const rpc = vi.fn(async () => ({
      data: { ok: true, code: null, providerReadbackState: "matched", paymentIntentId: "intent-1" },
      error: null,
    }));
    const port = createSupabaseAccountingInvoicePort({ rpc });

    await expect(port.preflightInvoiceIssuePayment({
      invoiceId: "invoice-1",
      outboxId: "outbox-1",
      claimAttemptCount: 2,
      providerStatus: "succeeded",
      providerAmountCents: 2990,
      providerCurrency: "PLN",
      providerEvidence: { source: "provider_api", provider: "stripe" },
    })).resolves.toMatchObject({ ok: true, providerReadbackState: "matched" });

    expect(rpc).toHaveBeenCalledWith("accounting_invoice_issue_payment_preflight", {
      p_invoice_id: "invoice-1",
      p_outbox_id: "outbox-1",
      p_claim_attempt_count: 2,
      p_provider_status: "succeeded",
      p_provider_amount_cents: 2990,
      p_provider_currency: "PLN",
      p_provider_evidence: { source: "provider_api", provider: "stripe" },
    });
  });

  it("fences provider success with the claimed attempt count", async () => {
    const rpc = vi.fn(async () => ({ data: { ok: true, code: null }, error: null }));
    const port = createSupabaseAccountingInvoicePort({ rpc });

    await port.markInvoiceIssueSucceeded({
      outboxId: "outbox-1",
      claimAttemptCount: 2,
      providerInvoiceId: "invoice-provider-1",
      providerInvoiceNumber: "FV/1/2026",
      providerRaw: { id: 1 },
    });

    expect(rpc).toHaveBeenCalledWith("accounting_invoice_issue_outbox_succeed", {
      p_outbox_id: "outbox-1",
      p_claim_attempt_count: 2,
      p_provider_invoice_id: "invoice-provider-1",
      p_provider_invoice_number: "FV/1/2026",
      p_provider_raw: { id: 1 },
    });
  });

  it("surfaces a rejected provider-success fence as a persistence error", async () => {
    const rpc = vi.fn(async () => ({
      data: { ok: false, code: "accounting_invoice_issue_claim_generation_mismatch" },
      error: null,
    }));
    const port = createSupabaseAccountingInvoicePort({ rpc });

    await expect(port.markInvoiceIssueSucceeded({
      outboxId: "outbox-1",
      claimAttemptCount: 1,
      providerInvoiceId: "invoice-provider-stale",
      providerInvoiceNumber: "FV/STALE",
      providerRaw: {},
    })).rejects.toMatchObject({
      causeCode: "accounting_invoice_issue_claim_generation_mismatch",
    });
  });

  it("fences issue failures with the claimed attempt and ignores stale owners", async () => {
    const rpc = vi.fn(async () => ({
      data: { ok: false, code: "accounting_invoice_issue_claim_generation_mismatch" },
      error: null,
    }));
    const port = createSupabaseAccountingInvoicePort({ rpc });

    await expect(port.markInvoiceIssueFailed({
      outboxId: "outbox-1",
      claimAttemptCount: 2,
      error: { message: "provider unavailable" },
      retrySeconds: 60,
    })).resolves.toBeUndefined();

    expect(rpc).toHaveBeenCalledWith("accounting_invoice_issue_outbox_fail", {
      p_outbox_id: "outbox-1",
      p_claim_attempt_count: 2,
      p_error: { message: "provider unavailable" },
      p_retry_seconds: 60,
    });
  });

  it("rejects non-fence issue failure errors", async () => {
    const rpc = vi.fn(async () => ({
      data: { ok: false, code: "accounting_invoice_issue_status_invalid" },
      error: null,
    }));
    const port = createSupabaseAccountingInvoicePort({ rpc });

    await expect(port.markInvoiceIssueFailed({
      outboxId: "outbox-1",
      claimAttemptCount: 2,
      error: { message: "provider unavailable" },
      retrySeconds: 60,
    })).rejects.toMatchObject({
      causeCode: "accounting_invoice_issue_status_invalid",
    });
  });

  it("routes reversal and correction jobs to their service-role RPCs", async () => {
    const rpc = vi.fn(async () => ({ data: [], error: null }));
    const port = createSupabaseAccountingInvoicePort({ rpc });

    await port.requestInvoiceReversalFromOrderStatus({
      idempotencyKey: "reversal-1",
      orderId: "order-1",
      reason: "order_refunded",
      providerKind: "fakturownia",
      payload: { source: "test" },
    });
    await port.claimInvoiceCorrections(7);
    await port.markInvoiceCorrectionSucceeded({
      outboxId: "outbox-1",
      providerInvoiceId: "correction-1",
      providerInvoiceNumber: "KOR/1/2026",
      providerRaw: { id: 123 },
    });
    await port.markInvoiceCorrectionFailed({
      outboxId: "outbox-2",
      error: { message: "retry" },
      retrySeconds: 60,
    });

    expect(rpc).toHaveBeenNthCalledWith(1, "accounting_invoice_request_reversal_from_order_status", {
      p_idempotency_key: "reversal-1",
      p_order_id: "order-1",
      p_reason: "order_refunded",
      p_payload: { source: "test" },
      p_provider_kind: "fakturownia",
    });
    expect(rpc).toHaveBeenNthCalledWith(2, "accounting_invoice_correction_outbox_claim", {
      p_limit: 7,
      p_lease_seconds: 300,
    });
    expect(rpc).toHaveBeenNthCalledWith(3, "accounting_invoice_correction_outbox_succeed", {
      p_outbox_id: "outbox-1",
      p_provider_invoice_id: "correction-1",
      p_provider_invoice_number: "KOR/1/2026",
      p_provider_raw: { id: 123 },
    });
    expect(rpc).toHaveBeenNthCalledWith(4, "accounting_invoice_correction_outbox_fail", {
      p_outbox_id: "outbox-2",
      p_error: { message: "retry" },
      p_retry_seconds: 60,
    });
  });

  it("wraps RPC errors", async () => {
    const rpc = vi.fn(async () => ({ data: null, error: { code: "P0001" } }));
    const port = createSupabaseAccountingInvoicePort({ rpc });

    await expect(port.requestInvoiceIssueFromPaidOrder({
      idempotencyKey: "paid-1",
      orderId: "order-1",
      providerKind: "fakturownia",
    })).rejects.toThrow(AccountingInvoicePersistenceError);
  });
});
