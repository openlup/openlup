import {
  accountingInvoiceIssueResponseSchema,
  accountingProviderSyncResponseSchema,
  paymentProviderSettlementResponseSchema,
  type AccountingInvoiceIssueRequest,
  type AccountingInvoiceIssueResponse,
  type AccountingProviderSyncEvent,
  type PaymentProviderSettlementRecord,
} from "../../../../src/domains/accounting/invoiceContracts.js";
import {
  AccountingControlConflictError,
  AccountingControlPersistenceError,
  type AccountingControlPort,
} from "../../../../src/domains/accounting/ports.js";

export interface AccountingSupabaseClient {
  rpc(functionName: string, args: Record<string, unknown>): PromiseLike<{ data: unknown; error: RpcError | null }>;
}

interface RpcError {
  code?: string;
  message?: string;
  details?: string;
  hint?: string;
}

export function createSupabaseAccountingControlPort(
  client: AccountingSupabaseClient,
): AccountingControlPort {
  return {
    async requestInvoiceIssue(
      request: AccountingInvoiceIssueRequest,
    ): Promise<AccountingInvoiceIssueResponse> {
      const { data, error } = await client.rpc("accounting_invoice_issue_request_v2", {
        p_idempotency_key: request.idempotencyKey,
        p_order_id: request.orderId,
        p_invoice_ref: request.invoiceRef,
        p_document_type: request.policy.documentType,
        p_buyer_kind: request.policy.buyerKind,
        p_ksef_requirement: request.policy.ksefRequirement,
        p_policy_version: request.policy.policyVersion,
        p_policy_approval_id: request.policyApprovalId,
        p_buyer_snapshot: request.buyerSnapshot,
        p_order_snapshot: request.orderSnapshot,
        p_tax_snapshot: request.taxSnapshot,
        p_lines_snapshot: request.linesSnapshot,
        p_total_net_cents: request.totalNetMinor,
        p_total_gross_cents: request.totalGrossMinor,
        p_provider_kind: request.providerKind,
      });
      if (error) throw mapAccountingRpcError(error, "Accounting invoice issue failed");
      return accountingInvoiceIssueResponseSchema.parse(data);
    },

    async recordProviderSyncEvent(event: AccountingProviderSyncEvent) {
      const { data, error } = await client.rpc("accounting_record_provider_sync_event", {
        p_idempotency_key: event.idempotencyKey,
        p_invoice_id: event.invoiceId,
        p_provider_kind: event.providerKind,
        p_provider_event_id: event.providerEventId,
        p_event_type: event.eventType,
        p_provider_invoice_id: event.providerInvoiceId,
        p_provider_invoice_number: event.providerInvoiceNumber,
        p_ksef_number: event.ksefNumber,
        p_ksef_status: event.ksefStatus,
        p_status_source: event.statusSource,
        p_provider_pdf_ref: event.providerPdfRef,
        p_provider_xml_ref: event.providerXmlRef,
        p_provider_upo_ref: event.providerUpoRef,
        p_observed_at: event.observedAt,
        p_payload_hash: event.payloadHash,
        p_payload: event.payload,
      });
      if (error) throw mapAccountingRpcError(error, "Accounting provider sync failed");
      return accountingProviderSyncResponseSchema.parse(data);
    },

    async recordPaymentSettlement(settlement: PaymentProviderSettlementRecord) {
      const { data, error } = await client.rpc("accounting_record_payment_settlement", {
        p_idempotency_key: settlement.idempotencyKey,
        p_provider_kind: settlement.providerKind,
        p_provider_batch_id: settlement.providerBatchId,
        p_provider_payment_id: settlement.providerPaymentId,
        p_payment_intent_id: settlement.paymentIntentId,
        p_payment_id: settlement.paymentId,
        p_invoice_id: settlement.invoiceId,
        p_gross_cents: settlement.grossMinor,
        p_fee_cents: settlement.feeMinor,
        p_net_cents: settlement.netMinor,
        p_currency: settlement.currency,
        p_status: settlement.status,
        p_bank_received_at: settlement.bankReceivedAt,
        p_evidence: settlement.evidence,
      });
      if (error) throw mapAccountingRpcError(error, "Payment settlement record failed");
      return paymentProviderSettlementResponseSchema.parse(data);
    },
  };
}

function mapAccountingRpcError(error: RpcError, fallback: string): Error {
  const text = [error.message, error.details, error.hint].filter(Boolean).join(" ");
  if (error.code === "23505" || /accounting_.*(?:conflict|invalid|mismatch|not_found|requires|approved)/.test(text)) {
    return new AccountingControlConflictError(fallback, { code: error.code, message: text });
  }
  return new AccountingControlPersistenceError(fallback, { code: error.code, message: text });
}
