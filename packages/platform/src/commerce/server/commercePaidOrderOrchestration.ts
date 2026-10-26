import type { PricingPolicySnapshot } from "../../pricing/index.js";
import type { CheckoutJourney, CheckoutKind, CommerceOrderDraftWritePort, CommerceCheckoutRuntimePort } from "../contracts/index.js";
import type { CommerceQuotePort } from "../ports.js";
import { CommerceOrderDraftPriceChangedError } from "../orderDraftErrors.js";
import { uuidFromOrderRef, messageOf } from "../checkoutHelpers.js";
import { CheckoutOrchestrationError } from "./commerceCheckoutOrchestrationError.js";
import type { CheckoutPaymentExecution } from "./commerceCheckoutProviderPayment.js";
import type { CheckoutQuoteSnapshot } from "./checkoutQuoteTypes.js";
import type { CheckoutExecutionProvider, CheckoutProviderFlow } from "./checkoutRuntimeTypes.js";
export interface CheckoutJourneyRuntimeRequest<Snapshot, PaymentExecution extends CheckoutPaymentExecution, Provider extends string = string, Flow extends string = string, MethodKind extends string = string, RecurringModel extends string = string> {
  idempotencyKey: string; paymentAttemptSequence?: number;
  orderDraft: { orderId: string; status: "draft"; paymentStatus: "not_started"; idempotencyKey: string; quoteSnapshot: Snapshot; replayed: boolean };
  mode: "one_time" | "subscription_cycle"; saveForFutureUse: boolean;
  clientId: string; shippingAddressId: string; paymentProvider: Provider;
  returnContext: "public" | "account"; providerFlow: Flow;
  paymentMethodRef?: string; paymentMethodAliasType?: MethodKind; paymentMethodRecurringModel?: RecurringModel;
  paymentExecution?: PaymentExecution; declaredBankId?: string;
  providerPayer?: { email: string; name: string; ip?: string | null; userAgent?: string | null };
  metadata: Record<string, unknown>;
}
export interface CheckoutJourneyRuntimeResponse<Provider extends string = string> {
  runtime: { orderId: string; payment: { paymentIntentId: string; paymentAttemptId: string | null; status: string; attemptStatus: string | null; provider: Provider; continuationActionOrigin?: "fresh_execution" | null; providerClientSecret?: string | null; providerAttemptId?: string | null; providerRedirectUrl?: string | null; providerNextActionKind?: string | null } };
}
export interface CheckoutJourneyResultRequest { idempotencyKey: string; orderId: string; paymentIntentId: string; resultStatus: "succeeded"; occurredAt: string }
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

export interface OrchestratedCheckoutResult<Snapshot, Provider extends string = string> {
  orderId: string;
  paymentIntentId: string;
  paymentAttemptId: string | null;
  paymentAttemptStatus?: string | null;
  runtimePaymentStatus?: string;
  executionRail: Provider;
  continuationActionOrigin: "fresh_execution" | null;
  providerClientSecret: string | null;
  providerPaymentId: string | null;
  providerRedirectUrl: string | null;
  providerNextActionKind: string | null;
  quoteSnapshot: Snapshot;
  status: "paid" | "processing" | "failed";
}

export type PaidOrderOrchestrationDeps<Provisioned, Request, Snapshot, Draft, Extension, Runtime, Settlement, PaymentExecution extends CheckoutPaymentExecution, Provider extends string = string, Flow extends string = string, MethodKind extends string = string, RecurringModel extends string = string> = {
  provisioned: Provisioned;
  checkoutKind: CheckoutKind;
  quotePort: CommerceQuotePort<Request, Snapshot, import("../../pricing/index.js").CreateQuoteOptions>;
  orderDraftPort: CommerceOrderDraftWritePort<{ idempotencyKey: string; quoteSnapshot: Snapshot }, Draft>;
  runtimePort: CommerceCheckoutRuntimePort<CheckoutJourneyRuntimeRequest<Snapshot, PaymentExecution, Provider, Flow, MethodKind, RecurringModel> & Extension, Runtime, CheckoutJourneyResultRequest, Settlement>;
  paymentProvider?: Provider;
    saveForFutureUse?: boolean;
    paymentAttemptSequence?: number;
  returnContext?: "public" | "account"; // Host redirect return; defaults to "public"
  paymentExecution?: PaymentExecution;
  declaredBankId?: string;
  paymentMethodRef?: string;
  paymentMethodAliasType?: MethodKind;
  paymentMethodRecurringModel?: RecurringModel;
  quoteSnapshot?: Snapshot;
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

export function createPaidOrderOrchestration<Provisioned extends { clientId: string; addressId: string }, Request, Snapshot extends CheckoutQuoteSnapshot, Draft extends { orderDraft: { orderId: string } }, Extension extends object, Runtime extends CheckoutJourneyRuntimeResponse<Provider>, Settlement, PaymentExecution extends CheckoutPaymentExecution, Provider extends string, Flow extends string, MethodKind extends string = string, RecurringModel extends string = string>(bindings: {
  defaultPaymentProvider: Provider; rehearsalPaymentProvider: Provider; confirmationProvider: Provider; missingConfirmationMessage: string;
  providerFlowFor(provider: Provider, execution: PaymentExecution | undefined): Flow;
  runtimeRequestExtension(provisioned: Provisioned): Extension;
  mapStartRuntimeFailure(error: unknown, draftOrderId: string): CheckoutOrchestrationError;
}) {

async function orchestrateCheckoutJourney(
  deps: PaidOrderOrchestrationDeps<Provisioned, Request, Snapshot, Draft, Extension, Runtime, Settlement, PaymentExecution, Provider, Flow, MethodKind, RecurringModel>,
  journey: CheckoutJourney<Request, PricingPolicySnapshot>,
): Promise<OrchestratedCheckoutResult<Snapshot, Provider>> {
  const {
    provisioned,
    checkoutKind,
    quotePort,
    orderDraftPort,
    runtimePort,
    paymentProvider = bindings.defaultPaymentProvider,
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
  const stage: CheckoutStageRecorder = recordStage ?? ((_stage, operation) => operation());

  // (b) quote(one_time) -> snapshot. No order persisted yet -> no compensation.
  let quoteSnapshot: Snapshot | undefined = providedQuoteSnapshot;
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
  let paymentContinuation: Pick<OrchestratedCheckoutResult<Snapshot, Provider>, "paymentAttemptId" | "paymentAttemptStatus" | "runtimePaymentStatus" | "executionRail" | "continuationActionOrigin">;
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
        // the provisional subscription; one_time would violate the mode contract.
        mode: checkoutKind === "subscription_initial" ? "subscription_cycle" : "one_time",
        saveForFutureUse: deps.saveForFutureUse ?? checkoutKind === "subscription_initial",
        clientId: provisioned.clientId, shippingAddressId: provisioned.addressId, ...bindings.runtimeRequestExtension(provisioned),
        paymentProvider,
        returnContext: deps.returnContext ?? "public",
        providerFlow: bindings.providerFlowFor(paymentProvider, paymentExecution),
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
    throw bindings.mapStartRuntimeFailure(error, draftOrderId);
  }

  // A confirmation-bearing runtime that returned without its confirmation capability has
  // already crossed the PSP boundary. Preserve the aggregate for payment-control
  // reconciliation rather than treating this post-dispatch contract failure as
  // permission to release stock or mint another attempt.
  const settledFreshRefusal = paymentContinuation.continuationActionOrigin === "fresh_execution"
    && paymentContinuation.runtimePaymentStatus === "failed" && paymentContinuation.paymentAttemptStatus === "failed"
    && Boolean(orderId && paymentIntentId && paymentContinuation.paymentAttemptId) && paymentContinuation.executionRail === paymentProvider;
  if (paymentProvider === bindings.confirmationProvider && !providerClientSecret && !settledFreshRefusal) {
    throw new CheckoutOrchestrationError(
      bindings.missingConfirmationMessage,
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
  if (paymentProvider === bindings.rehearsalPaymentProvider && !runtimeRefused) {
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
    status: paymentProvider === bindings.rehearsalPaymentProvider && !runtimeRefused ? "paid"
      : runtimeRefused ? "failed" : "processing",
  };
}

return { orchestrateCheckoutJourney };
}
