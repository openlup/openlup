import type { SubscriptionLifecycleTerms } from '@openlup/platform/subscriptions/contracts';
import type { NativeLifecycleMessagesOptions } from '@openlup/platform/subscriptions';

export interface RenewalNoticeText {
  paid: { subject: string; order: string; item: string; quantity: string; subtotal: string; discount: string; total: string };
  payment_failed: string; payment_expired: string; payment_recovery: string; payment_recovered: string;
  lifecycle: string; active: string; amount: string; retry: string; charge: string;
  repair: string; expires: string; unknown: string; address: string; addressApplied: string; addressNextParcel: string; status: string; minorUnits: string; cause: string;
  needsConfirmation: string; cannotRecur: string; methodDead: string; methodDataInvalid: string; methodMissing: string;
}

/** Non-secret application values; the installer and host consume this same input. */
export interface RenewalConfig {
  subscriptionCare: SubscriptionCareConfig;
  enabled: boolean;
  retryBackoffHours: number[];
  population: string;
  cadenceSeconds: number;
  batchLimit: number;
  leaseSeconds: number;
  sandbox: { initial: 'succeeded' | 'declined' | 'ambiguous'; retry: 'succeeded' | 'declined' | 'ambiguous' };
  recovery: { activeGraceSeconds: number; exhaustedTtlSeconds: number };
  notices: { locale: 'en' | 'pl'; countryLocales?: Record<string, 'en' | 'pl'>; copy: Record<'en' | 'pl', RenewalNoticeText> };
}

export function assertRenewalConfig(config: RenewalConfig): void {
  const copyKeys: (keyof RenewalNoticeText)[] = ['payment_failed', 'payment_expired', 'payment_recovery', 'payment_recovered',
    'lifecycle', 'active', 'amount', 'retry', 'charge', 'repair', 'expires', 'unknown', 'address', 'addressApplied', 'addressNextParcel', 'status', 'minorUnits', 'cause', 'needsConfirmation', 'cannotRecur', 'methodDead', 'methodDataInvalid', 'methodMissing'];
  if (!config || !Array.isArray(config.retryBackoffHours) || config.retryBackoffHours.some(value => !Number.isInteger(value) || value < 0 || value > 2147483647) || typeof config.enabled !== 'boolean' || typeof config.population !== 'string'
    || !/^[a-zA-Z0-9:-]{1,100}$/.test(config.population)
    || [config.cadenceSeconds, config.leaseSeconds, config.recovery?.activeGraceSeconds,
      config.recovery?.exhaustedTtlSeconds].some(value => !Number.isSafeInteger(value) || value < 1 || value > 2147483647)
    || config.leaseSeconds < 60 || config.leaseSeconds > 3600
    || !Number.isSafeInteger(config.batchLimit) || config.batchLimit < 1 || config.batchLimit > 100
    || !['succeeded', 'declined', 'ambiguous'].includes(config.sandbox?.initial)
    || !['succeeded', 'declined', 'ambiguous'].includes(config.sandbox?.retry)
    || !['en', 'pl'].includes(config.notices?.locale)
    || Object.entries(config.notices.countryLocales ?? {}).some(([country, locale]) => !/^[A-Z]{2}$/.test(country) || !['en', 'pl'].includes(locale))
    || !config.notices?.copy?.en || !config.notices?.copy?.pl
    || Object.values(config.notices.copy).some(copy => !copy.paid
      || ['subject', 'order', 'item', 'quantity', 'subtotal', 'discount', 'total'].some(key => {
        const value = copy.paid[key as keyof RenewalNoticeText['paid']];
        return typeof value !== 'string' || !value.trim();
      }))
    || Object.values(config.notices.copy).some(copy => copyKeys.some(key => typeof copy[key] !== 'string' || !copy[key].trim()))) {
    throw new Error('starter_renewal_configuration_invalid');
  }
  assertSubscriptionCare(config.subscriptionCare);
}

export interface SubscriptionCareConfig {
  enabled: boolean;
  batchLimit: number;
  leaseSeconds: number;
  recovered: { windowSeconds: number };
  terms: SubscriptionLifecycleTerms;
  retentionReasons: readonly string[];
  rescheduleOfferDays: number;
  dispatch: Required<NonNullable<NativeLifecycleMessagesOptions['dispatch']>>;
  notices: Required<NonNullable<NativeLifecycleMessagesOptions['notices']>>;
}
export function assertSubscriptionCare(config: SubscriptionCareConfig): void {
  const positive = (value: number) => Number.isInteger(value) && value > 0 && value <= 2147483647;
  if (!config || typeof config.enabled !== 'boolean' || !positive(config.batchLimit) || config.batchLimit > 100
    || !positive(config.leaseSeconds) || config.leaseSeconds < 60 || config.leaseSeconds > 3600
    || !positive(config.rescheduleOfferDays) || !config.recovered || !positive(config.recovered.windowSeconds) || !config.terms || !config.dispatch || !config.notices
    || [...Object.values(config.terms), ...Object.values(config.dispatch), ...Object.values(config.notices)].some(value => !positive(value))
    || config.terms.slideMinDays > config.terms.slideMaxDays
    || config.notices.renewalMinSeconds > config.notices.renewalMaxSeconds
    || config.notices.atRiskMinDays > config.notices.atRiskMaxDays
    || !config.retentionReasons?.length || config.retentionReasons.some(value => !/^[a-z][a-z0-9_]{0,119}$/.test(value))) {
    throw new Error('starter_subscription_care_configuration_invalid');
  }
}

export interface PortalSubscription {
  subscriptionId: string; status: string; nextCycleAt: string | null; editCutoffAt: string | null;
  blocker: string | null; action: { blockedReason?: string } | null;
  payment: { healthState?: string } | null;
  pause: { pausePreset?: string; pauseEndsAt?: string | null } | null;
  winback: { status?: string; refusal?: string | null; delivery_reference?: string | null } | null;
}
export type CareAction = 'skip' | 'slide' | 'pause' | 'resume' | 'cancel' | 'order_now' | 'reactivate';
/** UI availability mirrors the lifecycle rail; the server still authorizes every command. */
export function careAvailability(row: PortalSubscription, action: CareAction, now = Date.now()): string | null {
  if (action === 'reactivate') return row.status === 'cancelled' ? null : 'not_active';
  if (action === 'resume' && row.status !== 'paused') return 'not_active';
  if (action !== 'resume' && row.status !== 'active') return 'not_active';
  const blocked = row.action?.blockedReason;
  if (blocked === 'payment_blocked' && !['pause', 'cancel'].includes(action)) return 'payment_blocked';
  if (blocked === 'payment_expired' && !['cancel', 'resume'].includes(action)) return 'payment_expired';
  if (action === 'resume' && blocked === 'payment_expired' && row.payment?.healthState !== 'healthy') return 'missing_payment_method';
  if (!['skip', 'slide', 'order_now'].includes(action)) return null;
  if (row.blocker) return row.blocker;
  if (row.payment?.healthState !== 'healthy') return 'missing_payment_method';
  if (!row.nextCycleAt || row.editCutoffAt && Date.parse(row.editCutoffAt) <= now) return 'edit_window_closed';
  return null;
}
export function saveOfferKind(reason: string): 'skip' | 'reschedule' | 'pause' {
  return reason === 'too_much_product' ? 'skip' : reason === 'delivery_issue' ? 'reschedule' : 'pause';
}
/** Freeze this once when opening the offer: visible date and submitted target stay identical. */
export function saveRescheduleTarget(nextCycleAt: string | null, config: SubscriptionCareConfig, now = new Date()): string {
  const day = 86400000, lower = now.getTime() + config.terms.slideMinDays * day;
  const upper = now.getTime() + config.terms.slideMaxDays * day;
  const current = nextCycleAt ? Date.parse(nextCycleAt) : NaN;
  const target = (Number.isFinite(current) ? current : lower) + config.rescheduleOfferDays * day;
  const date = new Date(Math.min(Math.max(target, lower), upper));
  date.setHours(12, 0, 0, 0);
  return date.toISOString();
}
