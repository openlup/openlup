import type { SubscriptionEngineEventType, SubscriptionStatus } from "./types.js";
import type {
  EngineCycle,
  EngineEvent,
  EngineSubscription,
  SubscriptionEngineErrorCode,
  SubscriptionEngineResult,
} from "./subscriptionEngineTypes.js";
import type { SubscriptionTemplateSnapshot } from "./types.js";

/** @beta */
export function touchSubscription(
  subscription: EngineSubscription,
  updatedAt: string,
  patch: Partial<EngineSubscription>,
): EngineSubscription {
  return {
    ...subscription,
    ...patch,
    template: patch.template ? cloneTemplate(patch.template) : cloneTemplate(subscription.template),
    updatedAt,
  };
}

/** @beta */
export function makeEvent(input: {
  eventType: SubscriptionEngineEventType;
  subscription: EngineSubscription;
  cycleNumber?: number;
  idempotencyKey: string;
  occurredAt: string;
  payload: Record<string, unknown>;
}): EngineEvent {
  return {
    eventType: input.eventType,
    subscriptionId: input.subscription.id,
    cycleNumber: input.cycleNumber,
    idempotencyKey: input.idempotencyKey,
    occurredAt: input.occurredAt,
    payload: input.payload,
  };
}

/** @beta */
export function addCadenceDays(iso: string, cadenceDays: number): string | null {
  const date = parseIso(iso);
  if (!date || cadenceDays < 1) return null;
  return new Date(date.getTime() + cadenceDays * 24 * 60 * 60 * 1000).toJSON();
}

/** @beta */
export function parseIso(iso: string): Date | null {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return null;
  return date;
}

/** @beta */
export function validateTemplate(
  template: SubscriptionTemplateSnapshot,
): SubscriptionEngineResult<never> | null {
  if (template.cadence_days < 1 || template.lines.length === 0) {
    return failure("invalid_template", "template must have a positive cadence and at least one line");
  }

  for (const line of template.lines) {
    if (line.qty < 1) {
      return failure("invalid_template", "template lines must have positive quantities");
    }
  }

  return null;
}

/** @beta */
export function isTerminalCycle(cycle: EngineCycle): boolean {
  return cycle.status === "paid" || cycle.status === "skipped" || cycle.status === "cancelled";
}

/** @beta */
export function cloneTemplate(template: SubscriptionTemplateSnapshot): SubscriptionTemplateSnapshot {
  return {
    ...template,
    size_constraint: template.size_constraint ? cloneRecord(template.size_constraint) : null,
    lines: template.lines.map((line) => ({ ...line })),
  };
}

/** @beta */
export function cloneRecord<T extends Record<string, unknown>>(record: T): T {
  return JSON.parse(JSON.stringify(record)) as T;
}

/** @beta */
export function success<T>(value: T): SubscriptionEngineResult<T> {
  return { ok: true, value };
}

/** @beta */
export function failure(
  code: SubscriptionEngineErrorCode,
  message: string,
): SubscriptionEngineResult<never> {
  return { ok: false, error: { code, message } };
}

/** @beta */
export function statusPatch(status: SubscriptionStatus): Partial<EngineSubscription> {
  return { status };
}
