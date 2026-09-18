import type { SubscriptionSelfServiceAction } from "./selfServiceContracts.js";
import type { SubscriptionSelfServiceActionName } from "./selfServiceContracts.js";
import type {
  SubscriptionSelfServicePreviewContext,
  SubscriptionSelfServicePreviewResult,
} from "./selfServiceActions.js";
import type { SubscriptionStatus } from "./types.js";

export interface SubscriptionSelfServiceMutationResult {
  subscriptionId: string;
  action: SubscriptionSelfServiceActionName;
  status: "applied" | "replayed" | "noop";
  subscriptionStatus: SubscriptionStatus;
  nextCycleAt: string | null;
  templateVersion: number | null;
  eventId: string | null;
}

export interface SubscriptionMutationPort {
  previewSelfServiceAction(
    input: SubscriptionSelfServicePreviewContext,
  ): Promise<SubscriptionSelfServicePreviewResult>;

  applySelfServiceAction(input: {
    action: SubscriptionSelfServiceAction;
    now: string;
  }): Promise<SubscriptionSelfServiceMutationResult>;
}

/** One clock owns due selection, admission budgets, and delivery timestamps. */
export interface SubscriptionRuntimeClock {
  now(): Date;
}

export interface DunningDeliveryRequest {
  notificationId: string;
  correlationId: string;
  kind: "payment_failed" | "payment_expired";
  templateKey: string;
  attempt: number;
  recipient: { channel: "email"; address: string };
}

export interface DunningDeliveryOutcome {
  accepted: boolean;
  deliveryId: string | null;
  retryable: boolean;
  errorCode: string | null;
}

/**
 * Product copy, recovery credentials/URLs, and downstream adapter payloads do
 * not cross this neutral delivery boundary.
 */
export interface DunningDeliveryPort {
  deliver(
    request: DunningDeliveryRequest,
    signal: AbortSignal,
  ): Promise<DunningDeliveryOutcome>;
}

export class SubscriptionLifecycleNotConfiguredError extends Error {
  constructor(reason = "own_engine_disabled") {
    super(`Subscription own-engine lifecycle is not configured: ${reason}`);
    this.name = "SubscriptionLifecycleNotConfiguredError";
  }
}
