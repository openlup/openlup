import type {
  ApplyHiddenCheckoutPaymentResultRequest,
  ApplyHiddenCheckoutPaymentResultResponse,
  HiddenCheckoutRuntimeReadiness,
  HiddenCheckoutRuntimeReservation,
  StartHiddenCheckoutRuntimeRequest,
  StartHiddenCheckoutRuntimeResponse,
} from "./runtimeContracts.js";
import type {
  CheckoutCommandPersistenceResult,
  CheckoutCommandV1,
} from "./checkoutCommandContracts.js";
import type {
  CreateOrderDraftResponse,
  CreateQuoteResponse,
} from "./contracts.js";
import type { CommerceCurrency } from "./types.js";
import type {
  PaymentAttemptStatus,
  PaymentExecutionAttemptStatus,
  PaymentExecutionProvider,
  PaymentNextActionKind,
  PaymentIntentStatus,
  PaymentTargetKind,
} from "../payment/types.js";

export interface FinalizedCheckoutOrderItem {
  orderItemId: string;
  skuId: string;
  sku: string;
  quantity: number;
}

export interface FinalizedCheckoutOrder {
  orderId: string;
  orderRef: string;
  mode: "one_time" | "subscription_cycle";
  clientId: string;
  petId: string | null;
  shippingAddressId: string;
  subscriptionId: string | null;
  subscriptionCycleId: string | null;
  total: { amountMinor: number; currency: CommerceCurrency };
  items: FinalizedCheckoutOrderItem[];
  replayed: boolean;
}

export interface CommerceCheckoutRuntimeOrderPort {
  finalizeOrderForCheckout(
    request: StartHiddenCheckoutRuntimeRequest,
  ): Promise<FinalizedCheckoutOrder>;
}

export interface InventoryCheckoutReservationPort {
  reserveOrderItems(input: {
    idempotencyKey: string;
    order: FinalizedCheckoutOrder;
    paymentStatus: PaymentIntentStatus;
    metadata?: Record<string, unknown>;
  }): Promise<HiddenCheckoutRuntimeReservation[]>;
  releaseOrderReservations(input: {
    idempotencyKey: string;
    orderId: string;
    reason: string;
  }): Promise<{ releasedCount: number }>;
}

export interface PaymentControlRuntimePort {
  createIntent(input: {
    idempotencyKey: string;
    targetKind: PaymentTargetKind;
    orderId: string;
    subscriptionId: string | null;
    subscriptionCycleId: string | null;
    amountMinor: number;
    currency: CommerceCurrency;
    metadata: Record<string, unknown>;
  }): Promise<{
    paymentIntentId: string;
    paymentId: string;
    status: PaymentIntentStatus;
    replayed: boolean;
  }>;
  recordAttempt(input: {
    idempotencyKey: string;
    paymentIntentId: string;
    provider: PaymentExecutionProvider;
    providerAttemptId: string | null;
    providerSessionId: string | null;
    attemptStatus: PaymentExecutionAttemptStatus;
    nextActionKind: PaymentNextActionKind | null;
    requestPayload: Record<string, unknown>;
    responsePayload: Record<string, unknown>;
  }): Promise<{
    paymentAttemptId: string;
    status: PaymentAttemptStatus;
    replayed: boolean;
  }>;
  applyResult(input: ApplyHiddenCheckoutPaymentResultRequest): Promise<{
    paymentIntentId: string;
    paymentAttemptId: string;
    paymentId: string;
    orderId: string;
    status: ApplyHiddenCheckoutPaymentResultRequest["resultStatus"];
    kind: string;
    replayed: boolean;
  }>;
  /**
   * Closes a prepared interactive PSP attempt only after the trusted runtime
   * proves that no provider dispatch happened. This is deliberately a terminal
   * control-plane write, not a retry helper: the caller's one same-attempt
   * retry has already been exhausted before it reaches this boundary.
   */
  reopenInteractivePreparedAttempt?(input: {
    idempotencyKey: string;
    paymentIntentId: string;
    paymentAttemptId: string;
    expectedOrderId: string;
    expectedSubscriptionId: string | null;
    expectedSubscriptionCycleId: string | null;
    evidence: TrustedInteractivePreparedAttemptReopenEvidence;
  }): Promise<{
    paymentAttemptId: string;
    paymentIntentId: string;
    paymentAttemptStatus: "failed";
    paymentIntentStatus: "failed";
    replayed: boolean;
  }>;
}

/**
 * The two - and only two - proofs that the PSP holds no transaction for a prepared attempt. Separate
 * modes because each stands on a different fact: widening one into the other is how an
 * anti-double-charge boundary gets opened without anyone noticing.
 *
 * `trusted_pre_dispatch` - the HTTP transaction never started; it intentionally excludes response
 * decoding and transport failures, either of which can have reached the PSP.
 * `trusted_provider_refusal` - the one response-decoding case that is nonetheless provable, where
 * the PSP refused the request document itself and so cannot have created anything. Raised solely by
 * the Tpay dispatch boundary, on HTTP 400 with a parsed body whose every error code names a
 * request-document defect; a timeout, a transport loss, any other status, and an opaque or mixed
 * body all stay `unknown` and reach no mode here.
 */
export type TrustedInteractivePreparedAttemptReopenEvidence =
  | { mode: "trusted_pre_dispatch"; dispatchState: "not_dispatched"; phase: "oauth" | "transaction_dispatch"; reasonCode: "tpay_oauth_failed" | "tpay_oauth_timeout" | "tpay_oauth_invalid_response" | "tpay_request_encode_failed" | "tpay_request_deadline_exhausted" }
  | { mode: "trusted_provider_refusal"; dispatchState: "refused"; phase: "response_decode"; reasonCode: "tpay_request_refused" };

/**
 * Narrow capability used only by the interactive Tpay pre-dispatch exhaustion
 * handler. Generic payment-control consumers remain provider-neutral and must
 * explicitly fail closed when this capability is unavailable.
 */
export interface InteractivePreparedAttemptRuntimePort extends PaymentControlRuntimePort {
  reopenInteractivePreparedAttempt(input: {
    idempotencyKey: string;
    paymentIntentId: string;
    paymentAttemptId: string;
    expectedOrderId: string;
    expectedSubscriptionId: string | null;
    expectedSubscriptionCycleId: string | null;
    evidence: TrustedInteractivePreparedAttemptReopenEvidence;
  }): Promise<{
    paymentAttemptId: string;
    paymentIntentId: string;
    paymentAttemptStatus: "failed";
    paymentIntentStatus: "failed";
    replayed: boolean;
  }>;
}

export interface PreparedProviderAttemptRuntimePort extends PaymentControlRuntimePort {
  prepareProviderAttempt(input: {
    idempotencyKey: string;
    paymentIntentId: string;
    provider: PaymentExecutionProvider;
    providerIdempotencyKey: string;
    providerRequestFingerprint: string;
    providerFlow: string;
    paymentMethodRef?: string | null;
    requestPayload: Record<string, unknown>;
  }): Promise<{
    paymentAttemptId: string;
    status: PaymentAttemptStatus;
    replayed: boolean;
    providerAttemptId: string | null;
    providerSessionId: string | null;
    nextActionKind: PaymentNextActionKind | null;
  }>;
  finalizeProviderAttempt(input: {
    idempotencyKey: string;
    paymentIntentId: string;
    paymentAttemptId: string;
    providerIdempotencyKey: string;
    providerRequestFingerprint: string;
    providerAttemptId: string | null;
    providerSessionId: string | null;
    attemptStatus: PaymentExecutionAttemptStatus;
    nextActionKind: PaymentNextActionKind | null;
    requestPayload: Record<string, unknown>;
    responsePayload: Record<string, unknown>;
  }): Promise<{
    paymentAttemptId: string;
    status: PaymentAttemptStatus;
    replayed: boolean;
    providerAttemptId: string | null;
    providerSessionId: string | null;
    nextActionKind: PaymentNextActionKind | null;
  }>;
}

export interface CommerceRuntimeReadinessPort {
  evaluateOrderReadiness(input: {
    orderId: string;
    fallbackOrderItemCount: number | null;
    allOrderItemsHaveSku: boolean;
  }): Promise<HiddenCheckoutRuntimeReadiness>;
}

export interface CommerceCheckoutRuntimePort {
  startRuntime(
    request: StartHiddenCheckoutRuntimeRequest,
  ): Promise<StartHiddenCheckoutRuntimeResponse>;
  applyPaymentResult(
    request: ApplyHiddenCheckoutPaymentResultRequest,
  ): Promise<ApplyHiddenCheckoutPaymentResultResponse>;
}

/**
 * Persistence composition for the neutral command. Concrete adapters may map
 * their existing response into this deliberately non-configurator result.
 */
export interface CheckoutCommandPersistencePort {
  persistCheckoutCommand(command: CheckoutCommandV1): Promise<CheckoutCommandPersistenceResult>;
}

export interface CheckoutCommandRuntimeRequest {
  command: CheckoutCommandV1;
  /** Explicitly selected by composition; never defaulted by the command. */
  paymentProvider: PaymentExecutionProvider;
  /**
   * ⛔ There is deliberately no `providerFlow` here. `executeCheckoutCommand`
   * enumerates the fields it forwards to `startRuntime`, and this was never one
   * of them: the real flow is derived from the selected provider and the
   * execution result (`providerFlowFor`). A caller-supplied value on this port
   * read as authoritative while being discarded.
   */
  paymentAttemptSequence?: number;
  paymentMethodRef?: string;
  paymentMethodAliasType?: "UID" | "PAYID";
  paymentMethodRecurringModel?: "O" | "M";
  saveForFutureUse?: boolean;
  returnContext?: "public" | "account";
  providerPayer?: {
    email: string;
    name: string;
    ip?: string | null;
    userAgent?: string | null;
  };
  metadata?: Record<string, unknown>;
}

export interface CheckoutCommandRuntimeResult {
  quoteSnapshot: CreateQuoteResponse;
  persistence: CheckoutCommandPersistenceResult;
  orderDraft: CreateOrderDraftResponse;
  runtime: StartHiddenCheckoutRuntimeResponse;
  /**
   * Present only when the shared paid-order service settled the attempt in the
   * same call (the rehearsal/no-egress provider). `null` means the runtime is
   * still awaiting its terminal payment result, or already refused it.
   */
  settlement: ApplyHiddenCheckoutPaymentResultResponse | null;
}

export interface CheckoutCommandRuntimePort {
  startCheckoutCommand(
    request: CheckoutCommandRuntimeRequest,
  ): Promise<CheckoutCommandRuntimeResult>;
}

export class CommerceRuntimeConflictError extends Error {
  readonly details: Record<string, unknown>;

  constructor(message = "Commerce runtime conflict", details: Record<string, unknown> = {}) {
    super(message);
    this.name = "CommerceRuntimeConflictError";
    this.details = details;
  }
}

export class CommerceRuntimePersistenceError extends Error {
  readonly details: Record<string, unknown>;

  constructor(message = "Commerce runtime persistence failed", details: Record<string, unknown> = {}) {
    super(message);
    this.name = "CommerceRuntimePersistenceError";
    this.details = details;
  }
}
