import { requestBff, type BffRequestOptions } from "../../lib/bff/client.js";
import type {
  ActivateSubscriptionFromPaidCheckoutOrderRequest,
  ActivateSubscriptionFromPaidCheckoutOrderResponse,
  HandleSubscriptionPaymentFailureRequest,
  HandleSubscriptionPaymentFailureResponse,
  MarkSubscriptionDunningRecoveredRequest,
  MarkSubscriptionDunningRecoveredResponse,
  ResumeSubscriptionFromExpiredDunningRequest,
  ResumeSubscriptionFromExpiredDunningResponse,
  RunLocalReferenceRenewalTickResponse,
} from "./runtimeContracts.js";
import { runLocalReferenceRenewalTickResponseSchema } from "./runtimeContracts.js";

export interface HiddenSubscriptionRuntimePort {
  activateSubscriptionFromPaidCheckoutOrder(
    request: ActivateSubscriptionFromPaidCheckoutOrderRequest,
  ): Promise<ActivateSubscriptionFromPaidCheckoutOrderResponse>;
  handleSubscriptionPaymentFailure(
    request: HandleSubscriptionPaymentFailureRequest,
  ): Promise<HandleSubscriptionPaymentFailureResponse>;
  markSubscriptionDunningRecovered(
    request: MarkSubscriptionDunningRecoveredRequest,
  ): Promise<MarkSubscriptionDunningRecoveredResponse>;
  resumeSubscriptionFromExpiredDunning(
    request: ResumeSubscriptionFromExpiredDunningRequest,
  ): Promise<ResumeSubscriptionFromExpiredDunningResponse>;
}

/** Calls the profile-gated local operator boundary with its strict empty body. */
export function runLocalReferenceRenewalTick(
  options: BffRequestOptions = {},
): Promise<RunLocalReferenceRenewalTickResponse> {
  return requestBff(
    "/api/bff/subscriptions/renewal-ticks",
    runLocalReferenceRenewalTickResponseSchema,
    { ...options, method: "POST", body: {} },
  );
}

export class SubscriptionRuntimeConflictError extends Error {
  readonly details: Record<string, unknown>;

  constructor(message = "Subscription runtime conflict", details: Record<string, unknown> = {}) {
    super(message);
    this.name = "SubscriptionRuntimeConflictError";
    this.details = details;
  }
}

export class SubscriptionRuntimePersistenceError extends Error {
  readonly details: Record<string, unknown>;

  constructor(message = "Subscription runtime persistence failed", details: Record<string, unknown> = {}) {
    super(message);
    this.name = "SubscriptionRuntimePersistenceError";
    this.details = details;
  }
}

export class SubscriptionRuntimeDisabledError extends Error {
  readonly flag: string;

  constructor(flag: string) {
    super(`Subscription runtime disabled by ${flag}`);
    this.name = "SubscriptionRuntimeDisabledError";
    this.flag = flag;
  }
}
