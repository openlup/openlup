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

import type * as Core from "@openlup/platform/commerce/contracts";
export type { FinalizedCheckoutOrderItem } from "@openlup/platform/commerce/contracts";
export interface FinalizedCheckoutOrder extends Core.FinalizedCheckoutOrder<CommerceCurrency> { petId: string | null }
export type CommerceCheckoutRuntimeOrderPort = Core.CommerceCheckoutRuntimeOrderPort<StartHiddenCheckoutRuntimeRequest, FinalizedCheckoutOrder>;
export type InventoryCheckoutReservationPort = Core.InventoryCheckoutReservationPort<FinalizedCheckoutOrder, PaymentIntentStatus, HiddenCheckoutRuntimeReservation>;
interface PaymentVocabulary extends Core.CommercePaymentRuntimeVocabulary {
  currency: CommerceCurrency; intentStatus: PaymentIntentStatus; executionProvider: PaymentExecutionProvider;
  executionAttemptStatus: PaymentExecutionAttemptStatus; nextActionKind: PaymentNextActionKind;
  attemptStatus: PaymentAttemptStatus; targetKind: PaymentTargetKind;
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


export type PaymentControlRuntimePort = Core.PaymentControlRuntimePort<PaymentVocabulary, ApplyHiddenCheckoutPaymentResultRequest, TrustedInteractivePreparedAttemptReopenEvidence>;
export type InteractivePreparedAttemptRuntimePort = Core.InteractivePreparedAttemptRuntimePort<PaymentVocabulary, ApplyHiddenCheckoutPaymentResultRequest, TrustedInteractivePreparedAttemptReopenEvidence>;
export type PreparedProviderAttemptRuntimePort = Core.PreparedProviderAttemptRuntimePort<PaymentVocabulary, ApplyHiddenCheckoutPaymentResultRequest, TrustedInteractivePreparedAttemptReopenEvidence>;
export type CommerceRuntimeReadinessPort = Core.CommerceRuntimeReadinessPort<HiddenCheckoutRuntimeReadiness>;
export type CommerceCheckoutRuntimePort = Core.CommerceCheckoutRuntimePort<StartHiddenCheckoutRuntimeRequest, StartHiddenCheckoutRuntimeResponse, ApplyHiddenCheckoutPaymentResultRequest, ApplyHiddenCheckoutPaymentResultResponse>;
export type CheckoutCommandPersistencePort = Core.CheckoutCommandPersistencePort<CheckoutCommandV1, CheckoutCommandPersistenceResult>;
type CheckoutCommandRequestCore = Core.CheckoutCommandRuntimeRequest<CheckoutCommandV1, PaymentExecutionProvider>;
export interface CheckoutCommandRuntimeRequest extends CheckoutCommandRequestCore {
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


export type CheckoutCommandRuntimeResult = Core.CheckoutCommandRuntimeResult<CreateQuoteResponse, CheckoutCommandPersistenceResult, CreateOrderDraftResponse, StartHiddenCheckoutRuntimeResponse, ApplyHiddenCheckoutPaymentResultResponse>;
export type CheckoutCommandRuntimePort = Core.CheckoutCommandRuntimePort<CheckoutCommandRuntimeRequest, CheckoutCommandRuntimeResult>;
export { CommerceRuntimeConflictError, CommerceRuntimePersistenceError } from "@openlup/platform/commerce";
