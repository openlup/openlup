/** @beta */
export const SUBSCRIPTION_STATUSES = ["active", "paused", "cancelled", "completed"] as const;
/** @beta */
export type SubscriptionStatus = (typeof SUBSCRIPTION_STATUSES)[number];

// Full set of `subscriptions.status` values persisted in the DB (see the
// `subscriptions.status` CHECK constraint). This is a SUPERSET of the
// engine-managed lifecycle states above: it also includes the activation-flow
// states (`pending_activation`, `activation_failed`) that the recurring engine
// never transitions between. Read/display contracts that echo a stored row MUST
// accept all of these; the engine transition logic stays scoped to
// SUBSCRIPTION_STATUSES.
/** @beta */
export const SUBSCRIPTION_RECORD_STATUSES = [
  "pending_activation",
  "active",
  "paused",
  "cancelled",
  "completed",
  "activation_failed",
] as const;
/** @beta */
export type SubscriptionRecordStatus = (typeof SUBSCRIPTION_RECORD_STATUSES)[number];

/** @beta */
export const SUBSCRIPTION_CYCLE_STATUSES = [
  "planned",
  "payment_pending",
  "paid",
  "payment_failed",
  "retry_scheduled",
  "skipped",
  "cancelled",
] as const;
/** @beta */
export type SubscriptionCycleStatus = (typeof SUBSCRIPTION_CYCLE_STATUSES)[number];

/** @beta */
export const SUBSCRIPTION_ENGINE_EVENT_TYPES = [
  "subscription.created",
  "subscription.template_updated",
  "subscription.edit_window_opened",
  "subscription.next_cycle_at_updated",
  "subscription.cycle_planned",
  "subscription.payment_requested",
  "subscription.payment_failed",
  "subscription.retry_scheduled",
  "subscription.payment_recovered",
  "subscription.cycle_paid",
  "subscription.cycle_skipped",
  "subscription.cycle_cancelled",
  "subscription.paused",
  "subscription.resumed",
  "subscription.cancelled",
  "subscription.completed",
] as const;
/** @beta */
export type SubscriptionEngineEventType = (typeof SUBSCRIPTION_ENGINE_EVENT_TYPES)[number];

/** @beta */
export interface SubscriptionLineSnapshot {
  variant_id: string;
  qty: number;
  sort_order: number;
  is_addon: boolean;
}

/** @beta */
export interface SubscriptionTemplateSnapshot {
  cadence_days: number;
  size_constraint: Record<string, unknown> | null;
  currency: string;
  region_code: string;
  edit_window_hours?: number | null;
  lines: SubscriptionLineSnapshot[];
}

/** @beta */
export interface SubscriptionEngineEvent {
  event_id: string;
  event_type: SubscriptionEngineEventType;
  subscription_id: string;
  cycle_number?: number;
  template?: SubscriptionTemplateSnapshot;
  next_cycle_at?: string;
  payment_payload?: {
    payment_id?: string;
    amount_minor: number;
    currency: string;
    order_lines: Array<{
      variant_id: string;
      qty: number;
      unit_price_minor: number;
    }>;
  };
  raw_payload: Record<string, unknown>;
}

/** @beta */
export interface CreateSubscriptionInput {
  template: SubscriptionTemplateSnapshot;
  client_ref: string;
  payment_method_ref: string;
}
