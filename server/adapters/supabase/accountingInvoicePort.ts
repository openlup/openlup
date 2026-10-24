import { claimInvoiceSellerRevision } from "@openlup/platform/invoicing";
import type { InvoiceSellerRevision } from "@openlup/platform/invoicing/contracts";
import type { AccountingSellerConfig } from "../../../src/domains/accounting/invoiceContracts.js";
import {
  AccountingInvoicePersistenceError,
  AccountingControlConflictError,
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
  options: { readSeller?: () => Promise<({ readonly kind: "found" } & InvoiceSellerRevision<AccountingSellerConfig>) | { readonly kind: "unknown"; readonly code: "unknown" } | { readonly kind: "unsupported"; readonly code: "host_binding_required"; readonly retryable: false; readonly effectMayHaveSucceeded: false }> } = {},
): AccountingInvoiceIssuePort & Omit<AccountingInvoiceRuntimePort, "claimInvoiceCorrections"> & AccountingCorrectionScaffoldPort & {
  claimInvoiceCorrections(limit: number, options?: { orderId?: string | null }): Promise<AccountingCorrectionOutboxTarget[]>;
} {
  async function requestWithSellerPolicy(args: Record<string, unknown>) {
    const result = await client.rpc("invoicing_managed_request_with_seller_policy", args);
    if (result.error?.code === "55P03") {
      // This statement rolled back. Report before fail-soft fulfillment catches
      // the typed error so operators can recover the missing invoice request.
      console.warn("[accounting] invoice request refused", {
        kind: "refused",
        name: "AccountingInvoicePersistenceError",
        causeCode: "55P03",
        sourceKind: args.p_source_kind,
        sourceId: args.p_source_id,
        retryable: true,
        effectMayHaveSucceeded: false,
      });
    }
    return result;
  }

  async function sellerSelection() {
    if (!options.readSeller) throw new AccountingInvoicePersistenceError("Accounting seller selection required", "seller_unavailable");
    const selected = await claimInvoiceSellerRevision(options.readSeller);
    if (selected.kind !== "found") throw new AccountingInvoicePersistenceError("Accounting seller selection unavailable", selected.kind);
    return selected;
  }
  return {
    async requestInvoiceIssueFromFulfillmentHandoff(
      request: AccountingInvoiceIssueRequest,
    ): Promise<AccountingInvoiceIssueResponse> {
      const { data, error } = await requestWithSellerPolicy({
        p_key: request.idempotencyKey, p_source_kind: "handoff", p_source_id: request.fulfillmentOrderId,
        p_provider: request.providerKind, p_evidence: {},
      });
      if (error) {
        throw new AccountingInvoicePersistenceError("Accounting invoice issue request failed", error.code, error.message);
      }
      return data as AccountingInvoiceIssueResponse;
    },

    async requestInvoiceIssueFromPaidOrder(request): Promise<AccountingInvoiceIssueResponse> {
      const { data, error } = await requestWithSellerPolicy({
        p_key: request.idempotencyKey, p_source_kind: "paid", p_source_id: request.orderId,
        p_provider: request.providerKind, p_evidence: {},
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
      const selected = await sellerSelection();
      const { data, error } = await client.rpc("invoicing_managed_claim_with_seller", {
        p_limit: limit, p_order: options.orderId ?? null,
        p_seller: selected.seller, p_revision: selected.revisionRef,
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
      const { data, error } = await client.rpc("invoicing_managed_request_with_seller_policy", {
        p_key: `accounting-correction:${input.invoiceId}:${input.reason}`, p_source_kind: "correction",
        p_source_id: input.invoiceId, p_provider: input.providerKind,
        p_evidence: { ...input.payload, reason: input.reason },
      });
      if (error?.code === "23505") throw new AccountingControlConflictError("Accounting correction request conflict", { code: "identity_mismatch" });
      if (error) throw new AccountingInvoicePersistenceError("Accounting correction scaffold failed", error.code);
      return data as { correctionOutbox: { id: string; invoiceId: string; status: string } };
    },

    async requestInvoiceReversalFromOrderStatus(input) {
      const { data, error } = await client.rpc("invoicing_managed_request_with_seller_policy", {
        p_key: input.idempotencyKey, p_source_kind: "order_status_reversal",
        p_source_id: input.orderId, p_provider: input.providerKind,
        p_evidence: { reason: input.reason, payload: input.payload ?? {} },
      });
      if (error) throw new AccountingInvoicePersistenceError("Accounting invoice reversal failed", error.code);
      return data as { invoice: { id: string; status: string; providerInvoiceId: string | null } | null; action: string; replayed: boolean };
    },

    async claimInvoiceCorrections(limit: number, options: { orderId?: string | null } = {}): Promise<AccountingCorrectionOutboxTarget[]> {
      // The pinned correction wrapper has no order filter. Refuse before any lease.
      if (options.orderId) throw new AccountingInvoicePersistenceError("Order-scoped corrections unsupported", "unsupported");
      const selected = await sellerSelection();
      const { data, error } = await client.rpc("invoicing_managed_claim_corrections_with_seller", {
        p_limit: limit, p_seller: selected.seller, p_revision: selected.revisionRef,
      });
      if (error) throw new AccountingInvoicePersistenceError("Accounting correction claim failed", error.code);
      return asArray<AccountingCorrectionOutboxTarget>(data);
    },

    async markInvoiceCorrectionSucceeded(input): Promise<void> {
      const { data, error } = await client.rpc("accounting_invoice_correction_outbox_succeed", {
        p_outbox_id: input.outboxId,
        p_claim_attempt_count: input.claimAttemptCount,
        p_provider_invoice_id: input.providerInvoiceId,
        p_provider_invoice_number: input.providerInvoiceNumber,
        p_provider_raw: input.providerRaw,
      });
      if (error) throw new AccountingInvoicePersistenceError("Accounting correction success failed", error.code);
      if ((data as { ok?: boolean } | null)?.ok !== true) {
        throw new AccountingInvoicePersistenceError(
          "Accounting correction success was fenced", (data as { code?: string } | null)?.code,
        );
      }
    },

    async markInvoiceCorrectionFailed(input): Promise<void> {
      const { data, error } = await client.rpc("accounting_invoice_correction_outbox_fail", {
        p_outbox_id: input.outboxId,
        p_claim_attempt_count: input.claimAttemptCount,
        p_error: input.error,
        p_retry_seconds: input.retrySeconds,
      });
      if (error) throw new AccountingInvoicePersistenceError("Accounting correction failure failed", error.code);
      if ((data as { ok?: boolean } | null)?.ok !== true) {
        throw new AccountingInvoicePersistenceError(
          "Accounting correction failure was fenced", (data as { code?: string } | null)?.code,
        );
      }
    },
  };
}

function asArray<T>(value: unknown): T[] {
  return Array.isArray(value) ? value as T[] : [];
}
