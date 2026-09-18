import type {
  AccountingInvoiceIssueRequest as AccountingControlInvoiceIssueRequest,
  AccountingInvoiceIssueResponse as AccountingControlInvoiceIssueResponse,
  AccountingProviderSyncEvent,
  AdminAccountingOrderSummaryRequest,
  AdminAccountingOrderSummaryResponse,
  InvoiceDataLookupRequest,
  InvoiceDataLookupResponse,
  PaymentProviderSettlementRecord,
} from "./invoiceContracts.js";
import type { AccountingInvoiceDeliveryRuntimePort } from "./invoiceDeliveryPorts.js";
export type {
  AccountingDocumentProviderInvoiceSnapshot,
  AccountingDocumentProviderPort,
} from "./providerPorts.js";
export type {
  AccountingInvoiceEmailDeliveryInput,
  AccountingInvoiceEmailDeliveryPort,
  AccountingInvoiceEmailDeliveryResult,
  AccountingInvoiceDeliveryRuntimePort,
  AccountingInvoiceDeliveryTarget,
} from "./invoiceDeliveryPorts.js";

export interface AccountingInvoiceIssueRequest {
  idempotencyKey: string;
  fulfillmentOrderId: string;
  providerKind: "fakturownia" | string;
}

export interface AccountingPaidOrderInvoiceIssueRequest {
  idempotencyKey: string;
  orderId: string;
  providerKind: "fakturownia" | string;
}

export interface AccountingInvoiceIssueResponse {
  invoice: {
    id: string;
    invoiceRef: string;
    status: string;
    documentKind?: string | null;
    ksefRequired?: boolean;
    emailStatus?: string;
    blockedReason?: string | null;
    replayed: boolean;
  };
}

export interface AccountingPaidOrderInvoiceIssuePort {
  requestInvoiceIssueFromPaidOrder(
    request: AccountingPaidOrderInvoiceIssueRequest,
  ): Promise<AccountingInvoiceIssueResponse>;
}

export interface AccountingInvoiceIssuePort extends AccountingPaidOrderInvoiceIssuePort {
  requestInvoiceIssueFromFulfillmentHandoff(
    request: AccountingInvoiceIssueRequest,
  ): Promise<AccountingInvoiceIssueResponse>;
}

export interface ClaimedAccountingInvoiceIssue {
  claimContractVersion?: "accounting.issue.v1" | "accounting.issue.v2";
  outboxId: string;
  attemptCount: number;
  providerKind: string;
  payment: {
    intentId: string;
    provider: string;
    providerPaymentId: string | null;
    amountCents: number;
    currency: string;
    localSettlementState: "matched" | "unavailable";
  };
  invoice: {
    id: string;
    orderId: string;
    orderRef: string;
    invoiceRef: string;
    documentKind: string | null;
    ksefRequired: boolean;
    currency: string;
    buyerSnapshot: Record<string, unknown>;
    orderSnapshot: Record<string, unknown>;
    taxSnapshot: Record<string, unknown>;
    linesSnapshot: unknown[];
    totalNetCents: number;
    totalGrossCents: number;
    /**
     * Frozen canonical order header joined at claim time. Shipping and its
     * discount are explicit; the residual equation remains an invariant, not
     * an alternate source from which a document may re-derive delivery.
     */
    orderMoney?: {
      subtotalCents: number;
      discountCents: number;
      shippingCents: number;
      shippingDiscountCents: number;
      totalCents: number;
    } | null;
    paymentCompletedAt: string | null;
    packageShippedAt: string | null;
    providerPaymentId: string | null;
    metadata: Record<string, unknown>;
  };
}

export interface AccountingKsefPollTarget {
  invoiceId: string;
  providerKind: string;
  providerInvoiceId: string;
  providerInvoiceNumber: string | null;
  ksefStatus: string;
}

export interface AccountingCorrectionOutboxTarget {
  outboxId: string;
  attemptCount: number;
  providerKind: string;
  invoiceId: string;
  providerInvoiceId: string;
  correctionReason: string;
  payload: Record<string, unknown>;
  invoice: {
    id: string;
    orderRef: string;
    invoiceRef: string;
    documentKind: string | null;
    ksefRequired: boolean;
    currency: string;
    buyerSnapshot: Record<string, unknown>;
    linesSnapshot: unknown[];
    totalGrossCents: number;
    providerInvoiceId: string;
    providerInvoiceNumber: string | null;
  };
}

export interface AccountingInvoiceRuntimePort extends AccountingInvoiceDeliveryRuntimePort {
  claimInvoiceIssues(limit: number, options?: { orderId?: string | null }): Promise<ClaimedAccountingInvoiceIssue[]>;
  preflightInvoiceIssuePayment(input: {
    invoiceId: string;
    outboxId: string;
    claimAttemptCount: number;
    providerStatus: "succeeded" | "failed" | "pending" | "unknown" | "unavailable";
    providerAmountCents: number | null;
    providerCurrency: string | null;
    providerEvidence: Record<string, unknown>;
  }): Promise<{
    ok: boolean;
    code: string | null;
    providerReadbackState: "matched" | "mismatch" | "unavailable";
    paymentIntentId: string | null;
  }>;
  blockInvoiceIssueCanonicalMapper(input: {
    invoiceId: string;
    outboxId: string;
    claimAttemptCount: number;
    code: string;
    evidence: Record<string, unknown>;
  }): Promise<void>;
  markInvoiceIssueSucceeded(input: {
    outboxId: string;
    claimAttemptCount: number;
    providerInvoiceId: string;
    providerInvoiceNumber: string | null;
    providerRaw: Record<string, unknown>;
  }): Promise<void>;
  markInvoiceIssueFailed(input: {
    outboxId: string;
    claimAttemptCount: number;
    error: Record<string, unknown>;
    retrySeconds: number;
  }): Promise<void>;
  listKsefPollTargets(limit: number): Promise<AccountingKsefPollTarget[]>;
  recordKsefStatus(input: {
    invoiceId: string;
    ksefNumber: string | null;
    ksefStatus: "pending" | "accepted" | "rejected" | "not_submitted";
    payload: Record<string, unknown>;
  }): Promise<void>;
  recordProviderDocumentSync(input: {
    invoiceId: string;
    providerKind: string;
    providerEventId: string;
    eventType: "invoice.pdf_ready" | "invoice.xml_ready" | "ksef.accepted" | "ksef.rejected" | "ksef.pending" | "provider.mismatch";
    providerInvoiceId: string;
    providerInvoiceNumber: string | null;
    ksefNumber: string | null;
    ksefStatus: "pending" | "accepted" | "rejected" | "not_submitted" | "not_required" | null;
    providerPdfRef: string | null;
    providerXmlRef: string | null;
    providerUpoRef: string | null;
    observedAt: string;
    payloadHash: string;
    payload: Record<string, unknown>;
  }): Promise<void>;
  claimInvoiceCorrections(limit: number): Promise<AccountingCorrectionOutboxTarget[]>;
  markInvoiceCorrectionSucceeded(input: {
    outboxId: string;
    providerInvoiceId: string;
    providerInvoiceNumber: string | null;
    providerRaw: Record<string, unknown>;
  }): Promise<void>;
  markInvoiceCorrectionFailed(input: {
    outboxId: string;
    error: Record<string, unknown>;
    retrySeconds: number;
  }): Promise<void>;
}

export interface AccountingCorrectionScaffoldPort {
  requestCorrectionScaffold(input: {
    invoiceId: string;
    reason: string;
    payload: Record<string, unknown>;
    providerKind: string;
  }): Promise<{ correctionOutbox: { id: string; invoiceId: string; status: string } }>;
  requestInvoiceReversalFromOrderStatus(input: {
    idempotencyKey: string;
    orderId: string;
    reason: "order_canceled" | "order_refunded";
    providerKind: string;
    payload?: Record<string, unknown>;
  }): Promise<{ invoice: { id: string; status: string; providerInvoiceId: string | null } | null; action: string; replayed: boolean }>;
}

export interface AccountingControlPort {
  requestInvoiceIssue(
    request: AccountingControlInvoiceIssueRequest,
  ): Promise<AccountingControlInvoiceIssueResponse>;
  recordProviderSyncEvent(
    event: AccountingProviderSyncEvent,
  ): Promise<{ eventId: string; replayed: boolean }>;
  recordPaymentSettlement(
    settlement: PaymentProviderSettlementRecord,
  ): Promise<{ settlementItemId: string; replayed: boolean }>;
}

export interface AccountingReadPort {
  getOrderSummary(
    request: AdminAccountingOrderSummaryRequest,
  ): Promise<AdminAccountingOrderSummaryResponse>;
}

export interface InvoiceDataLookupPort {
  lookupInvoiceData(request: InvoiceDataLookupRequest): Promise<InvoiceDataLookupResponse>;
}

/**
 * Provider-neutral persistence failure surfaced to accounting policy.
 *
 * `causeCode` and `causeMessage` carry the durable backend refusal identity
 * without exposing an SDK error type or a concrete adapter to domain callers.
 */
export class AccountingInvoicePersistenceError extends Error {
  constructor(
    message: string,
    readonly causeCode?: string,
    readonly causeMessage?: string,
  ) {
    super(message);
    this.name = "AccountingInvoicePersistenceError";
  }
}

export class AccountingControlConflictError extends Error {
  readonly details: Record<string, unknown>;

  constructor(message = "Accounting control conflict", details: Record<string, unknown> = {}) {
    super(message);
    this.name = "AccountingControlConflictError";
    this.details = details;
  }
}

export class AccountingControlPersistenceError extends Error {
  readonly details: Record<string, unknown>;

  constructor(message = "Accounting control persistence failed", details: Record<string, unknown> = {}) {
    super(message);
    this.name = "AccountingControlPersistenceError";
    this.details = details;
  }
}
