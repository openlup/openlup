import type { ConfiguratorIntent } from "../../../src/domains/commerce/configuratorIntentContracts.js";
import type { CreateQuoteResponse } from "../../../src/domains/commerce/contracts.js";
import {
  CommerceOrderDraftPriceChangedError,
  type CommerceQuotePort,
  type CommerceOrderDraftWritePort,
} from "../../../src/domains/commerce/ports.js";
import type { CommerceCheckoutRuntimePort } from "../../../src/domains/commerce/runtimePorts.js";
import type { CheckoutInvoicePreference, CheckoutKind } from "../../../src/domains/commerce/checkoutContracts.js";
import type { CommerceCustomerDefaultsSnapshot } from "../../../src/domains/commerce/customerDefaultsSnapshotContracts.js";
import type { PaymentExecutionProvider } from "../../../src/domains/payment/types.js";
import type { CheckoutPaymentExecution } from "../../../src/domains/commerce/paymentExecutionContracts.js";
import { providerFlowFor } from "./commerceCheckoutProviderPayment.js";
import {
  configuratorCheckoutJourney,
  messageOf,
  uuidFromOrderRef,
  type CheckoutJourney,
} from "./commerceCheckoutOrchestrationHelpers.js";
import { CheckoutOrchestrationError } from "./commerceCheckoutOrchestrationError.js";
import { mapStartRuntimeFailure } from "./commerceCheckoutStartRuntimeFailure.js";

export { CheckoutOrchestrationError } from "./commerceCheckoutOrchestrationError.js";
export { tryCompensate } from "./commerceCheckoutCompensation.js";
export type { CheckoutCompensationPort } from "./commerceCheckoutCompensation.js";

export interface CheckoutPaymentStartedEvent {
  email: string;
  clientId: string;
  orderId: string;
  paymentIntentId: string;
}

export type CheckoutStage =
  | "quote"
  | "order_draft"
  | "start_runtime"
  | "account_link"
  | "apply_payment_result";

export type CheckoutStageRecorder = <T>(
  stage: CheckoutStage,
  operation: () => Promise<T>,
) => Promise<T>;

interface OrchestrateBaseDeps {
  provisioned: { clientId: string; petId: string | null; addressId: string };
  checkoutKind: CheckoutKind;
  quotePort: CommerceQuotePort;
  orderDraftPort: CommerceOrderDraftWritePort;
  runtimePort: CommerceCheckoutRuntimePort;
  paymentProvider?: PaymentExecutionProvider;
  /** Overrides the `checkoutKind`-derived default; see the checkout contract. */
  saveForFutureUse?: boolean;
  /** Retry identity for the same journey; see the checkout contract. */
  paymentAttemptSequence?: number;
  returnContext?: "public" | "account"; // Tpay redirect return; defaults to "public"
  paymentExecution?: CheckoutPaymentExecution;
  declaredBankId?: string;
  paymentMethodRef?: string;
  paymentMethodAliasType?: "UID" | "PAYID";
  paymentMethodRecurringModel?: "O" | "M";
  quoteSnapshot?: CreateQuoteResponse;
  providerPayer?: {
    email: string;
    name: string;
    ip?: string | null;
    userAgent?: string | null;
  };
  onPaymentStarted?: (event: CheckoutPaymentStartedEvent) => Promise<void>;
  recordStage?: CheckoutStageRecorder;
  now: () => Date;
}

/**
 * One application service, two entry mappings. `journey` is the neutral entry
 * used by the checkout-command adapter; `intent` is the legacy configurator
 * mapping, which this module projects onto the same journey.
 */
export type OrchestrateDeps = OrchestrateBaseDeps &
  (
    | {
        journey: CheckoutJourney;
        intent?: undefined;
        invoicePreference?: undefined;
        customerDefaultsSnapshot?: undefined;
      }
    | {
        journey?: undefined;
        intent: ConfiguratorIntent;
        invoicePreference: CheckoutInvoicePreference;
        customerDefaultsSnapshot?: CommerceCustomerDefaultsSnapshot | null;
      }
  );
export interface OrchestratedCheckoutResult {
  orderId: string;
  paymentIntentId: string;
  paymentAttemptId: string | null;
  paymentAttemptStatus?: string | null;
  runtimePaymentStatus?: string;
  executionRail: PaymentExecutionProvider;
  continuationActionOrigin: "fresh_execution" | null;
  providerClientSecret: string | null;
  providerPaymentId: string | null;
  providerRedirectUrl: string | null;
  providerNextActionKind: string | null;
  quoteSnapshot: CreateQuoteResponse;
  status: "paid" | "processing" | "failed";
}

export async function orchestratePaidOrder(
  deps: OrchestrateDeps,
): Promise<OrchestratedCheckoutResult> {
  const {
    provisioned,
    checkoutKind,
    quotePort,
    orderDraftPort,
    runtimePort,
    paymentProvider = "hidden_rehearsal",
    paymentAttemptSequence,
    paymentExecution,
    declaredBankId,
    paymentMethodRef,
    paymentMethodAliasType,
    paymentMethodRecurringModel,
    quoteSnapshot: providedQuoteSnapshot,
    providerPayer,
    onPaymentStarted,
    recordStage,
    now,
  } = deps;
  const journey: CheckoutJourney = deps.journey ?? configuratorCheckoutJourney(
    deps.intent,
    provisioned,
    checkoutKind,
    deps.invoicePreference,
    deps.customerDefaultsSnapshot,
  );
  const stage: CheckoutStageRecorder = recordStage ?? ((_stage, operation) => operation());

  // (b) quote(one_time) -> snapshot. No order persisted yet -> no compensation.
  let quoteSnapshot: CreateQuoteResponse | undefined = providedQuoteSnapshot;
  if (!quoteSnapshot) {
    try {
      quoteSnapshot = await stage("quote", () =>
        quotePort.createQuote(journey.createQuoteRequest(), { clientId: provisioned.clientId }),
      );
    } catch (error) {
      throw new CheckoutOrchestrationError(messageOf(error, "quote"), null);
    }
  }

  // (c) order-draft(idempotencyKey, snapshot). If the canonical writer throws,
  // its transaction (including any promotion claim) rolls back, so there is no
  // persisted order id to compensate.
  let draftOrderId: string;
  try {
    const draft = await stage("order_draft", () =>
      orderDraftPort.createOrderDraft(
        { idempotencyKey: journey.idempotencyKey, quoteSnapshot },
        { clientId: provisioned.clientId }, // out-of-band -> commerce_orders.client_id -> outbox recipient
      ),
    );
    draftOrderId = uuidFromOrderRef(draft.orderDraft.orderId);
  } catch (error) {
    if (error instanceof CommerceOrderDraftPriceChangedError) {
      throw new CheckoutOrchestrationError(
        messageOf(error, "order_draft"),
        null,
        "promotion_code_price_changed",
      );
    }
    throw new CheckoutOrchestrationError(messageOf(error, "order_draft"), null);
  }

  // (d) startRuntime -> finalizes order, reserves inventory, opens payment intent.
  // From here on a throw leaves a live reservation, so compensation targets the order.
  let orderId: string;
  let paymentIntentId: string;
  let paymentContinuation: Pick<OrchestratedCheckoutResult, "paymentAttemptId" | "paymentAttemptStatus" | "runtimePaymentStatus" | "executionRail" | "continuationActionOrigin">;
  let providerClientSecret: string | null;
  let providerPaymentId: string | null;
  let providerRedirectUrl: string | null;
  let providerNextActionKind: string | null;
  let runtimeRefused: boolean;
  try {
    const started = await stage("start_runtime", () =>
      runtimePort.startRuntime({
        idempotencyKey: journey.idempotencyKey,
        paymentAttemptSequence,
        orderDraft: {
          orderId: `order_${draftOrderId}`,
          status: "draft",
          paymentStatus: "not_started",
          idempotencyKey: journey.idempotencyKey,
          quoteSnapshot,
          replayed: false,
        },
        // subscription_initial finalizes as subscription_cycle: finalize creates+links
        // the provisional subscription (20260610150000); one_time would trip D10.2.
        mode: checkoutKind === "subscription_initial" ? "subscription_cycle" : "one_time",
        saveForFutureUse: deps.saveForFutureUse ?? checkoutKind === "subscription_initial",
        clientId: provisioned.clientId, shippingAddressId: provisioned.addressId, petId: provisioned.petId,
        paymentProvider,
        returnContext: deps.returnContext ?? "public",
        providerFlow: providerFlowFor(paymentProvider, paymentExecution),
        paymentMethodRef, paymentMethodAliasType, paymentMethodRecurringModel,
        paymentExecution,
        declaredBankId,
        providerPayer,
        metadata: journey.createRuntimeMetadata(quoteSnapshot.quote.context?.pricingPolicy),
      }),
    );
    orderId = started.runtime.orderId;
    paymentIntentId = started.runtime.payment.paymentIntentId;
    paymentContinuation = { paymentAttemptStatus: started.runtime.payment.attemptStatus, runtimePaymentStatus: started.runtime.payment.status, paymentAttemptId: started.runtime.payment.paymentAttemptId, executionRail: started.runtime.payment.provider, continuationActionOrigin: started.runtime.payment.continuationActionOrigin ?? null };
    providerClientSecret = started.runtime.payment.providerClientSecret ?? null;
    providerPaymentId = started.runtime.payment.providerAttemptId ?? null;
    providerRedirectUrl = started.runtime.payment.providerRedirectUrl ?? null;
    providerNextActionKind = started.runtime.payment.providerNextActionKind ?? null;
    runtimeRefused = started.runtime.payment.status === "failed" || started.runtime.payment.attemptStatus === "failed";
  } catch (error) {
    // startRuntime is itself a multi-step saga; reservations may already exist.
    throw mapStartRuntimeFailure(error, draftOrderId);
  }

  // A real Stripe runtime that returned without its confirmation capability has
  // already crossed the PSP boundary. Preserve the aggregate for payment-control
  // reconciliation rather than treating this post-dispatch contract failure as
  // permission to release stock or mint another attempt.
  const settledFreshRefusal = paymentContinuation.continuationActionOrigin === "fresh_execution"
    && paymentContinuation.runtimePaymentStatus === "failed" && paymentContinuation.paymentAttemptStatus === "failed"
    && Boolean(orderId && paymentIntentId && paymentContinuation.paymentAttemptId) && paymentContinuation.executionRail === paymentProvider;
  if (paymentProvider === "stripe" && !providerClientSecret && !settledFreshRefusal) {
    throw new CheckoutOrchestrationError(
      "stripe_processing_without_client_secret",
      null,
      "provider_attempt_in_flight",
    );
  }

  if (onPaymentStarted && !runtimeRefused) {
    try {
      await stage("account_link", () =>
        onPaymentStarted({
          email: journey.contactEmail,
          clientId: provisioned.clientId,
          orderId,
          paymentIntentId,
        }),
      );
    } catch {
      console.warn("checkout_payment_started_hook_failed", JSON.stringify({ orderId }));
    }
  }

  // (e) For the rehearsal no-op provider only: applyPaymentResult(succeeded).
  // For real PSPs, the saga returns `"processing"`; payment-control is flipped
  // by the webhook (Wave B) once the provider confirms the charge. Auto-marking
  // a real-provider intent as `succeeded` here would bypass the webhook proof
  // and risk a "local paid / provider unpaid" mismatch. A rehearsal adapter that
  // already declined (the reference profile's refusal simulator) must never be
  // auto-settled as succeeded either — the runtime's own terminal answer wins.
  if (paymentProvider === "hidden_rehearsal" && !runtimeRefused) {
    try {
      await stage("apply_payment_result", () =>
        runtimePort.applyPaymentResult({
          idempotencyKey: journey.idempotencyKey,
          orderId,
          paymentIntentId,
          resultStatus: "succeeded",
          occurredAt: now().toISOString(),
        }),
      );
    } catch (error) {
      throw new CheckoutOrchestrationError(messageOf(error, "apply_payment_result"), orderId);
    }

  }

  return {
    orderId,
    paymentIntentId,
    ...paymentContinuation,
    providerClientSecret,
    providerPaymentId,
    providerRedirectUrl,
    providerNextActionKind,
    quoteSnapshot,
    // A refusal the saga already knows about must not be reported as a wait.
    status: paymentProvider === "hidden_rehearsal" && !runtimeRefused ? "paid"
      : runtimeRefused ? "failed" : "processing",
  };
}
