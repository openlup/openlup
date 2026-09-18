export {
  SUBSCRIPTION_CYCLE_STATUSES,
  SUBSCRIPTION_ENGINE_EVENT_TYPES,
  SUBSCRIPTION_RECORD_STATUSES,
  SUBSCRIPTION_STATUSES,
} from "@openlup/core/subscription";
import type {
  CreateSubscriptionInput as CoreCreateSubscriptionInput,
  SubscriptionEngineEvent as CoreSubscriptionEngineEvent,
  SubscriptionTemplateSnapshot as CoreSubscriptionTemplateSnapshot,
} from "@openlup/core/subscription";
export type {
  SubscriptionCycleStatus,
  SubscriptionEngineEventType,
  SubscriptionLineSnapshot,
  SubscriptionRecordStatus,
  SubscriptionStatus,
} from "@openlup/core/subscription";

export interface SubscriptionTemplateSnapshot extends CoreSubscriptionTemplateSnapshot {
  /**
   * Opaque reference to the subscription's SUBJECT — the consumer of the goods,
   * not necessarily the buyer. Models the "buyer ≠ consumer" axis explicitly:
   * a caregiver may buy on behalf of the household member consuming the goods,
   * and buying for oneself is the degenerate case (subject empty / self). The
   * subject-profile schema and consumption resolver stay vertical-owned; the
   * platform core gains no table. New code reads `subject_ref`.
   *
   * Additive + never persisted here: this field is a TS-type concern only. The
   * persisted template snapshot is rebuilt server-side by
   * `subscription_current_template_snapshot` and guarded by deep JSONB equality,
   * so `subject_ref` must never leak into a stored payload.
   */
  subject_ref?: string | null;
  /** @deprecated use subject_ref — retained as an alias to extinction. */
  pet_id?: string | null;
}

export interface CreateSubscriptionInput extends Omit<CoreCreateSubscriptionInput, "template"> {
  template: SubscriptionTemplateSnapshot;
}

export interface SubscriptionEngineEvent extends Omit<CoreSubscriptionEngineEvent, "template"> {
  template?: SubscriptionTemplateSnapshot;
}
