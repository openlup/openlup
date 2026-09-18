import type {
  SubscriptionCycleStatus,
  SubscriptionEngineEventType,
  SubscriptionStatus,
  SubscriptionTemplateSnapshot,
} from "./types.js";

/** @beta */
export const DEFAULT_EDIT_WINDOW_HOURS = 72;
/** @beta */
export const DEFAULT_TIMEZONE = "UTC";

/** @beta */
export type SubscriptionEngineErrorCode =
  | "invalid_timestamp"
  | "invalid_template"
  | "inactive_subscription"
  | "edit_window_closed"
  | "line_not_found"
  | "duplicate_line"
  | "invalid_slide_target"
  | "invalid_transition"
  | "terminal_cycle";

/** @beta */
export type SubscriptionEngineResult<T> =
  | { ok: true; value: T }
  | { ok: false; error: { code: SubscriptionEngineErrorCode; message: string } };

/** @beta */
export interface EngineSubscription {
  id: string;
  clientRef: string;
  status: SubscriptionStatus;
  template: SubscriptionTemplateSnapshot;
  templateVersion: number;
  nextCycleAt: string;
  paymentMethodRef: string | null;
  paymentMethodKind: string | null;
  timezone: string;
  createdAt: string;
  updatedAt: string;
}

/** @beta */
export interface EngineCycle {
  subscriptionId: string;
  cycleNumber: number;
  status: SubscriptionCycleStatus;
  scheduledAt: string;
  paidAt: string | null;
  templateVersion: number;
  templateSnapshot: SubscriptionTemplateSnapshot;
  pricingSnapshot: Record<string, unknown>;
  paymentMethodRef: string | null;
  retryAttempt: number;
  nextRetryAt: string | null;
  failureReason: string | null;
  engineIdempotencyKey: string;
}

/** @beta */
export interface EngineEvent {
  eventType: SubscriptionEngineEventType;
  subscriptionId: string;
  cycleNumber?: number;
  idempotencyKey: string;
  occurredAt: string;
  payload: Record<string, unknown>;
}

/** @beta */
export interface CreateInitialSubscriptionCheckoutInput {
  subscriptionId: string;
  clientRef: string;
  template: SubscriptionTemplateSnapshot;
  paymentMethodRef?: string | null;
  paymentMethodKind?: string | null;
  firstCycleAt: string;
  now: string;
  pricingSnapshot: Record<string, unknown>;
  idempotencyKey: string;
  timezone?: string | null;
}

/** @beta */
export interface PlanCycleInput {
  subscription: EngineSubscription;
  cycleNumber: number;
  now: string;
  pricingSnapshot: Record<string, unknown>;
  idempotencyKey: string;
}

/** @beta */
export interface SubscriptionMutationResult {
  subscription: EngineSubscription;
  events: EngineEvent[];
}

/** @beta */
export interface CycleMutationResult {
  cycle: EngineCycle;
  events: EngineEvent[];
}

/** @beta */
export interface InitialSubscriptionCheckoutModel {
  subscription: EngineSubscription;
  cycle: EngineCycle;
  events: EngineEvent[];
}
