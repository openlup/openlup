import {
  activateSubscriptionFromPaidCheckoutOrderResponseSchema,
  handleSubscriptionPaymentFailureResponseSchema,
  markSubscriptionDunningRecoveredResponseSchema,
  resumeSubscriptionFromExpiredDunningResponseSchema,
} from "../../../../src/domains/subscription/runtimeContracts.js";
import {
  SubscriptionRuntimeConflictError,
  SubscriptionRuntimePersistenceError,
  type HiddenSubscriptionRuntimePort,
} from "../../../../src/domains/subscription/runtimePorts.js";

export interface ManagedSubscriptionRuntimeClient {
  rpc(functionName: string, args: Record<string, unknown>): PromiseLike<{ data: unknown; error: RpcError | null }>;
}

interface RpcError {
  code?: string;
  message?: string;
  details?: string;
  hint?: string;
}

export function createManagedSubscriptionRuntimePort(
  client: ManagedSubscriptionRuntimeClient,
): HiddenSubscriptionRuntimePort {
  return {
    async activateSubscriptionFromPaidCheckoutOrder(request) {
      const { data, error } = await client.rpc("subscription_activate_from_paid_checkout_order", {
        p_idempotency_key: request.idempotencyKey,
        p_order_id: request.orderId,
        p_payment_intent_id: request.paymentIntentId,
        p_payment_method_ref: request.paymentMethodRef,
        p_payment_method_kind: request.paymentMethodKind,
        p_paid_at: request.paidAt,
      });
      if (error) throw mapRpcError(error, "Subscription activation RPC failed");
      return parseRpcResponse(
        data,
        activateSubscriptionFromPaidCheckoutOrderResponseSchema,
        "Subscription activation response invalid",
      );
    },

    async handleSubscriptionPaymentFailure(request) {
      const { data, error } = await client.rpc("subscription_handle_payment_failure_dunning", {
        p_idempotency_key: request.idempotencyKey,
        p_cycle_id: request.cycleId,
        p_subscription_id: request.subscriptionId,
        p_order_id: request.orderId,
        p_payment_intent_id: request.paymentIntentId,
        p_retry_attempt: request.retryAttempt,
        p_next_retry_at: request.nextRetryAt ?? null,
        p_failure_reason: request.failureReason ?? null,
        p_occurred_at: request.occurredAt,
      });
      if (error) throw mapRpcError(error, "Subscription dunning RPC failed");
      return parseRpcResponse(
        data,
        handleSubscriptionPaymentFailureResponseSchema,
        "Subscription dunning response invalid",
      );
    },

    async markSubscriptionDunningRecovered(request) {
      const { data, error } = await client.rpc("subscription_mark_dunning_recovered", {
        p_idempotency_key: request.idempotencyKey,
        p_case_id: request.caseId,
        p_payment_intent_id: request.paymentIntentId,
        p_recovered_at: request.recoveredAt,
      });
      if (error) throw mapRpcError(error, "Subscription dunning recovery RPC failed");
      return parseRpcResponse(
        data,
        markSubscriptionDunningRecoveredResponseSchema,
        "Subscription dunning recovery response invalid",
      );
    },

    async resumeSubscriptionFromExpiredDunning(request) {
      const { data, error } = await client.rpc("subscription_resume_from_dunning_with_cycle_order", {
        p_idempotency_key: request.idempotencyKey,
        p_recovery_token: request.recoveryToken,
        p_payment_method_ref: request.paymentMethodRef,
        p_payment_method_kind: request.paymentMethodKind,
        p_cycle_number: request.cycleNumber,
        p_scheduled_at: request.scheduledAt,
        p_template_snapshot: request.templateSnapshot,
        p_pricing_snapshot: request.pricingSnapshot,
        p_order_snapshot: request.orderSnapshot,
        p_requested_at: request.requestedAt,
      });
      if (error) throw mapRpcError(error, "Subscription dunning resume RPC failed");
      return parseRpcResponse(
        data,
        resumeSubscriptionFromExpiredDunningResponseSchema,
        "Subscription dunning resume response invalid",
      );
    },
  };
}

function parseRpcResponse<T>(
  data: unknown,
  schema: { safeParse: (value: unknown) => { success: true; data: T } | { success: false } },
  message: string,
): T {
  const parsed = schema.safeParse(data);
  if (!parsed.success) {
    throw new SubscriptionRuntimePersistenceError(message);
  }
  return parsed.data;
}

function mapRpcError(error: RpcError, fallbackMessage: string): Error {
  const text = [error.message, error.details, error.hint].filter(Boolean).join(" ");
  if (
    error.code === "23505" ||
    /subscription_(?:activation|dunning|payment_recovery)_.*(?:conflict|invalid|missing|not_found|mismatch|stale|already|not_paid|not_succeeded|not_subscription|not_recovered|state|expired|fresh)/.test(
      text,
    )
  ) {
    return new SubscriptionRuntimeConflictError("Subscription runtime conflict", {
      code: error.code,
      message: error.message,
    });
  }
  return new SubscriptionRuntimePersistenceError(fallbackMessage, { code: error.code });
}
