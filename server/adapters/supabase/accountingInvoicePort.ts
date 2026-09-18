import {
  AccountingInvoicePersistenceError,
  type AccountingCorrectionScaffoldPort,
  type AccountingCorrectionOutboxTarget,
  type AccountingInvoiceDeliveryTarget,
  type AccountingInvoiceRuntimePort,
  type AccountingInvoiceIssuePort,
  type AccountingInvoiceIssueRequest,
  type AccountingInvoiceIssueResponse,
  type AccountingKsefPollTarget,
  type ClaimedAccountingInvoiceIssue,
} from "../../../src/domains/accounting/ports.js";

export interface AccountingSupabaseClient {
  rpc(functionName: string, args: Record<string, unknown>): PromiseLike<{ data: unknown; error: RpcError | null }>;
}

interface RpcError {
  code?: string;
  message?: string;
  details?: string;
  hint?: string;
}
export function createSupabaseAccountingInvoicePort(
  client: AccountingSupabaseClient,
): AccountingInvoiceIssuePort & AccountingInvoiceRuntimePort & AccountingCorrectionScaffoldPort {
  return {
    async requestInvoiceIssueFromFulfillmentHandoff(
      request: AccountingInvoiceIssueRequest,
    ): Promise<AccountingInvoiceIssueResponse> {
      const { data, error } = await client.rpc("accounting_invoice_issue_request_from_handoff", {
        p_idempotency_key: request.idempotencyKey,
        p_fulfillment_order_id: request.fulfillmentOrderId,
        p_provider_kind: request.providerKind,
      });
      if (error) {
        throw new AccountingInvoicePersistenceError("Accounting invoice issue request failed", error.code, error.message);
      }
      return data as AccountingInvoiceIssueResponse;
    },

    async requestInvoiceIssueFromPaidOrder(request): Promise<AccountingInvoiceIssueResponse> {
      const { data, error } = await client.rpc("accounting_invoice_issue_request_from_paid_order", {
        p_idempotency_key: request.idempotencyKey,
        p_order_id: request.orderId,
        p_provider_kind: request.providerKind,
      });
      if (error) {
        throw new AccountingInvoicePersistenceError("Accounting paid invoice issue request failed", error.code, error.message);
      }
      return data as AccountingInvoiceIssueResponse;
    },

    async claimInvoiceIssues(
      limit: number,
      options: { orderId?: string | null } = {},
    ): Promise<ClaimedAccountingInvoiceIssue[]> {
      const { data, error } = await client.rpc("accounting_invoice_issue_outbox_claim", {
        p_limit: limit,
        p_lease_seconds: 300,
        p_order_id: options.orderId ?? null,
        p_contract_version: "accounting.issue.v2",
      });
      if (error) throw new AccountingInvoicePersistenceError("Accounting invoice issue claim failed", error.code);
      return asArray<ClaimedAccountingInvoiceIssue>(data);
    },

    async preflightInvoiceIssuePayment(input) {
      const { data, error } = await client.rpc("accounting_invoice_issue_payment_preflight", {
        p_invoice_id: input.invoiceId,
        p_outbox_id: input.outboxId,
        p_claim_attempt_count: input.claimAttemptCount,
        p_provider_status: input.providerStatus,
        p_provider_amount_cents: input.providerAmountCents,
        p_provider_currency: input.providerCurrency,
        p_provider_evidence: input.providerEvidence,
      });
      if (error) {
        throw new AccountingInvoicePersistenceError("Accounting invoice payment preflight failed", error.code);
      }
      return data as {
        ok: boolean;
        code: string | null;
        providerReadbackState: "matched" | "mismatch" | "unavailable";
        paymentIntentId: string | null;
      };
    },

    async blockInvoiceIssueCanonicalMapper(input): Promise<void> {
      const { data, error } = await client.rpc("accounting_invoice_issue_block_canonical_mapper", {
        p_invoice_id: input.invoiceId,
        p_outbox_id: input.outboxId,
        p_claim_attempt_count: input.claimAttemptCount,
        p_code: input.code,
        p_evidence: input.evidence,
      });
      if (error) {
        throw new AccountingInvoicePersistenceError("Accounting canonical mapper block failed", error.code);
      }
      if ((data as { ok?: boolean } | null)?.ok !== true) {
        throw new AccountingInvoicePersistenceError(
          "Accounting canonical mapper block was fenced",
          (data as { code?: string } | null)?.code,
        );
      }
    },

    async markInvoiceIssueSucceeded(input): Promise<void> {
      const { data, error } = await client.rpc("accounting_invoice_issue_outbox_succeed", {
        p_outbox_id: input.outboxId,
        p_claim_attempt_count: input.claimAttemptCount,
        p_provider_invoice_id: input.providerInvoiceId,
        p_provider_invoice_number: input.providerInvoiceNumber,
        p_provider_raw: input.providerRaw,
      });
      if (error) throw new AccountingInvoicePersistenceError("Accounting invoice issue success failed", error.code);
      if ((data as { ok?: boolean } | null)?.ok !== true) {
        throw new AccountingInvoicePersistenceError(
          "Accounting invoice issue success was fenced",
          (data as { code?: string } | null)?.code,
        );
      }
    },

    async markInvoiceIssueFailed(input): Promise<void> {
      const { data, error } = await client.rpc("accounting_invoice_issue_outbox_fail", {
        p_outbox_id: input.outboxId,
        p_claim_attempt_count: input.claimAttemptCount,
        p_error: input.error,
        p_retry_seconds: input.retrySeconds,
      });
      if (error) throw new AccountingInvoicePersistenceError("Accounting invoice issue failure failed", error.code);
      if (
        (data as { ok?: boolean; code?: string } | null)?.ok === false
        && !(data as { code?: string }).code?.startsWith("accounting_invoice_issue_claim_")
      ) {
        throw new AccountingInvoicePersistenceError(
          "Accounting invoice issue failure was rejected",
          (data as { code?: string }).code,
        );
      }
    },

    async claimInvoiceDeliveries(
      limit: number,
      options: { requireKsefAcceptanceForB2b?: boolean; orderId?: string | null } = {},
    ): Promise<AccountingInvoiceDeliveryTarget[]> {
      const { data, error } = await client.rpc("accounting_invoice_delivery_outbox_claim", {
        p_limit: limit,
        p_lease_seconds: 300,
        p_require_ksef_acceptance_for_b2b: options.requireKsefAcceptanceForB2b !== false,
        p_order_id: options.orderId ?? null,
      });
      if (error) throw new AccountingInvoicePersistenceError("Accounting invoice delivery claim failed", error.code);
      return asArray<AccountingInvoiceDeliveryTarget>(data);
    },

    async markInvoiceDeliverySucceeded(input): Promise<void> {
      const { error } = await client.rpc("accounting_invoice_delivery_outbox_resend_succeed", {
        p_outbox_id: input.outboxId,
        p_attempt_count: input.claimAttemptCount,
        p_provider_invoice_id: input.providerInvoiceId,
        p_provider_message_id: input.providerMessageId,
      });
      if (error) throw new AccountingInvoicePersistenceError("Accounting invoice delivery success failed", error.code);
    },

    async markInvoiceDeliveryFailed(input): Promise<void> {
      const { error } = await client.rpc("accounting_invoice_delivery_outbox_resend_fail", {
        p_outbox_id: input.outboxId,
        p_attempt_count: input.claimAttemptCount,
        p_provider_invoice_id: input.providerInvoiceId,
        p_error: input.error,
        p_retry_seconds: input.retrySeconds,
      });
      if (error) throw new AccountingInvoicePersistenceError("Accounting invoice delivery failure failed", error.code);
    },

    async markInvoiceDeliveryUncertain(input): Promise<void> {
      const { error } = await client.rpc("accounting_invoice_delivery_outbox_resend_uncertain", {
        p_outbox_id: input.outboxId,
        p_attempt_count: input.claimAttemptCount,
        p_provider_invoice_id: input.providerInvoiceId,
        p_error: input.error,
        p_provider_message_id: input.providerMessageId,
      });
      if (error) throw new AccountingInvoicePersistenceError("Accounting invoice delivery uncertain failed", error.code);
    },

    async listKsefPollTargets(limit: number): Promise<AccountingKsefPollTarget[]> {
      const { data, error } = await client.rpc("accounting_invoice_ksef_poll_candidates", {
        p_limit: limit,
      });
      if (error) throw new AccountingInvoicePersistenceError("Accounting KSeF poll candidates failed", error.code);
      return asArray<AccountingKsefPollTarget>(data);
    },

    async recordKsefStatus(input): Promise<void> {
      const { error } = await client.rpc("accounting_invoice_record_ksef_status", {
        p_invoice_id: input.invoiceId,
        p_ksef_number: input.ksefNumber,
        p_ksef_status: input.ksefStatus,
        p_payload: input.payload,
      });
      if (error) throw new AccountingInvoicePersistenceError("Accounting KSeF status record failed", error.code);
    },

    async recordProviderDocumentSync(input): Promise<void> {
      const { error } = await client.rpc("accounting_record_provider_sync_event", {
        p_idempotency_key: `${input.providerEventId}:${input.invoiceId}`,
        p_invoice_id: input.invoiceId,
        p_provider_kind: input.providerKind,
        p_provider_event_id: input.providerEventId,
        p_event_type: input.eventType,
        p_provider_invoice_id: input.providerInvoiceId,
        p_provider_invoice_number: input.providerInvoiceNumber,
        p_ksef_number: input.ksefNumber,
        p_ksef_status: input.ksefStatus,
        p_status_source: "provider_api",
        p_provider_pdf_ref: input.providerPdfRef,
        p_provider_xml_ref: input.providerXmlRef,
        p_provider_upo_ref: input.providerUpoRef,
        p_observed_at: input.observedAt,
        p_payload_hash: input.payloadHash,
        p_payload: input.payload,
      });
      if (error) throw new AccountingInvoicePersistenceError("Accounting provider document sync failed", error.code);
    },

    async requestCorrectionScaffold(input) {
      const { data, error } = await client.rpc("accounting_invoice_request_correction_scaffold", {
        p_invoice_id: input.invoiceId,
        p_reason: input.reason,
        p_payload: input.payload,
        p_provider_kind: input.providerKind,
      });
      if (error) throw new AccountingInvoicePersistenceError("Accounting correction scaffold failed", error.code);
      return data as { correctionOutbox: { id: string; invoiceId: string; status: string } };
    },

    async requestInvoiceReversalFromOrderStatus(input) {
      const { data, error } = await client.rpc("accounting_invoice_request_reversal_from_order_status", {
        p_idempotency_key: input.idempotencyKey,
        p_order_id: input.orderId,
        p_reason: input.reason,
        p_payload: input.payload ?? {},
        p_provider_kind: input.providerKind,
      });
      if (error) throw new AccountingInvoicePersistenceError("Accounting invoice reversal failed", error.code);
      return data as { invoice: { id: string; status: string; providerInvoiceId: string | null } | null; action: string; replayed: boolean };
    },

    async claimInvoiceCorrections(limit: number): Promise<AccountingCorrectionOutboxTarget[]> {
      const { data, error } = await client.rpc("accounting_invoice_correction_outbox_claim", {
        p_limit: limit,
        p_lease_seconds: 300,
      });
      if (error) throw new AccountingInvoicePersistenceError("Accounting correction claim failed", error.code);
      return asArray<AccountingCorrectionOutboxTarget>(data);
    },

    async markInvoiceCorrectionSucceeded(input): Promise<void> {
      const { error } = await client.rpc("accounting_invoice_correction_outbox_succeed", {
        p_outbox_id: input.outboxId,
        p_provider_invoice_id: input.providerInvoiceId,
        p_provider_invoice_number: input.providerInvoiceNumber,
        p_provider_raw: input.providerRaw,
      });
      if (error) throw new AccountingInvoicePersistenceError("Accounting correction success failed", error.code);
    },

    async markInvoiceCorrectionFailed(input): Promise<void> {
      const { error } = await client.rpc("accounting_invoice_correction_outbox_fail", {
        p_outbox_id: input.outboxId,
        p_error: input.error,
        p_retry_seconds: input.retrySeconds,
      });
      if (error) throw new AccountingInvoicePersistenceError("Accounting correction failure failed", error.code);
    },
  };
}

function asArray<T>(value: unknown): T[] {
  return Array.isArray(value) ? value as T[] : [];
}
