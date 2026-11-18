import type { SubscriptionCommandAdmission, SubscriptionLifecycleTerms } from '@openlup/platform/subscriptions/contracts';
import type { NativeLifecycleMessagesOptions } from '@openlup/platform/subscriptions';
import { assertChoice, type Choice } from './policy.ts';
import { assertLocaleCopy, supportedLocales, configuredLocales, type Locale, type LocaleCopy } from './locales.ts';

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
  notices: { locale: Locale; countryLocales?: Record<string, Locale>; copy: LocaleCopy<RenewalNoticeText> };
}

export function assertRenewalConfig(config: RenewalConfig, locales: readonly Locale[] = configuredLocales): void {
  if (!config || !Array.isArray(config.retryBackoffHours) || config.retryBackoffHours.some(value => !Number.isInteger(value) || value < 0 || value > 2147483647) || typeof config.enabled !== 'boolean' || typeof config.population !== 'string'
    || !/^[a-zA-Z0-9:-]{1,100}$/.test(config.population)
    || [config.cadenceSeconds, config.leaseSeconds, config.recovery?.activeGraceSeconds,
      config.recovery?.exhaustedTtlSeconds].some(value => !Number.isSafeInteger(value) || value < 1 || value > 2147483647)
    || config.leaseSeconds < 60 || config.leaseSeconds > 3600
    || !Number.isSafeInteger(config.batchLimit) || config.batchLimit < 1 || config.batchLimit > 100
    || !['succeeded', 'declined', 'ambiguous'].includes(config.sandbox?.initial)
    || !['succeeded', 'declined', 'ambiguous'].includes(config.sandbox?.retry)
    || !supportedLocales.includes(config.notices?.locale)
    || Object.entries(config.notices.countryLocales ?? {}).some(([country, locale]) => !/^[A-Z]{2}$/.test(country) || !supportedLocales.includes(locale))) {
    throw new Error('starter_renewal_configuration_invalid');
  }
  const copyKeys: (keyof RenewalNoticeText)[] = ['payment_failed', 'payment_expired', 'payment_recovery', 'payment_recovered',
    'lifecycle', 'active', 'amount', 'retry', 'charge', 'repair', 'expires', 'unknown', 'address', 'addressApplied', 'addressNextParcel',
    'status', 'minorUnits', 'cause', 'needsConfirmation', 'cannotRecur', 'methodDead', 'methodDataInvalid', 'methodMissing'];
  const paidKeys: (keyof RenewalNoticeText['paid'])[] = ['subject', 'order', 'item', 'quantity', 'subtotal', 'discount', 'total'];
  assertLocaleCopy(config.notices.copy, locales, 'renewal.notices.copy', [...copyKeys, ...paidKeys.map(key => `paid.${key}`)]);
  if (config.retryBackoffHours.length !== 3) throw new Error('starter_database_retry_budget');
  assertSubscriptionCare(config.subscriptionCare);
}

export interface SubscriptionCareConfig {
  enabled: boolean;
  batchLimit: number;
  leaseSeconds: number;
  recovered: { windowSeconds: number };
  terms: SubscriptionLifecycleTerms;
  retentionReasons: readonly string[];
  retention: { offerByReason: Readonly<Record<string, SaveOfferKind>>; defaultOffer: SaveOfferKind;
    /** Pause choice preselected in the cancellation save offer; defaults to pausePresets.default. */
    pausePreset?: PausePreset };
  actions: Record<'active' | 'paused' | 'cancelled' | 'whilePaymentBlocked' | 'whilePaymentExpired', readonly CareAction[]>;
  pausePresets: Choice<PausePreset>;
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
  const keys = ['active', 'paused', 'cancelled', 'whilePaymentBlocked', 'whilePaymentExpired'] as const;
  if (!config.actions || Object.keys(config.actions).some(key => !keys.some(known => known === key))
    || keys.some(key => !Array.isArray(config.actions[key]) || new Set(config.actions[key]).size !== config.actions[key].length
      || config.actions[key].some(action => !careActions.includes(action)))) {
    throw new Error('starter_subscription_actions_invalid');
  }
  assertChoice(config.pausePresets, pausePresetVocabulary, 'starter_pause_presets_invalid');
}

export interface PortalSubscription {
  subscriptionId: string; status: string; nextCycleAt: string | null; editCutoffAt: string | null;
  blocker: string | null; action: { blockedReason?: string } | null;
  payment: { healthState?: string } | null;
  pause: { pausePreset?: string; pauseEndsAt?: string | null } | null;
  winback: { status?: string; refusal?: string | null; delivery_reference?: string | null } | null;
}
export const careActions = ['skip', 'slide', 'pause', 'resume', 'cancel', 'order_now', 'reactivate'] as const;
export type CareAction = typeof careActions[number];
const pausePresetVocabulary = ['2_weeks', '1_month', 'indefinite'] as const;
export type PausePreset = typeof pausePresetVocabulary[number];
function carePolicyRefusal(config: SubscriptionCareConfig, status: string, paymentBlocker: string | null, action: string): string | null {
  const actions = Object.hasOwn(config.actions, status) ? config.actions[status as keyof typeof config.actions] : [];
  if (!actions.some(allowed => allowed === action)) return 'action_disabled';
  // Reactivation already has its own native payment/confirmation fences. Historical
  // account payment messages have never disabled it in the starter.
  if (action === 'reactivate') return null;
  if (paymentBlocker === 'payment_blocked' && !config.actions.whilePaymentBlocked.some(allowed => allowed === action)) return 'payment_blocked';
  if (paymentBlocker === 'payment_expired' && !config.actions.whilePaymentExpired.some(allowed => allowed === action)) return 'payment_expired';
  return null;
}
/** Shared owned-data admission. The port calls this only after completed replay. */
export function admitCareCommand(config: SubscriptionCareConfig, facts: Parameters<SubscriptionCommandAdmission>[0]): void {
  if (carePolicyRefusal(config, facts.subscriptionStatus, facts.paymentBlocker, facts.action)) throw new Error('starter_subscription_action_not_admitted');
  if (facts.action === 'pause' && !config.pausePresets.allowed.some(preset => preset === facts.pausePreset)) throw new Error('starter_pause_preset_not_admitted');
}
/** UI availability mirrors the lifecycle rail; the server still authorizes every command. */
export function careAvailability(row: PortalSubscription, action: CareAction, config: SubscriptionCareConfig, now = Date.now()): string | null {
  if (action === 'reactivate') return row.status === 'cancelled' ? carePolicyRefusal(config, row.status, row.action?.blockedReason ?? null, action) : 'not_active';
  if (action === 'resume' && row.status !== 'paused') return 'not_active';
  if (action !== 'resume' && row.status !== 'active' && !(action === 'cancel' && row.status === 'paused')) return 'not_active';
  const blocked = row.action?.blockedReason;
  const policyRefusal = carePolicyRefusal(config, row.status, blocked ?? null, action);
  if (policyRefusal) return policyRefusal;
  if (action === 'resume' && blocked === 'payment_expired' && row.payment?.healthState !== 'healthy') return 'missing_payment_method';
  if (!['skip', 'slide', 'order_now'].includes(action)) return null;
  if (row.blocker) return row.blocker;
  if (row.payment?.healthState !== 'healthy') return 'missing_payment_method';
  if (!row.nextCycleAt || row.editCutoffAt && Date.parse(row.editCutoffAt) <= now) return 'edit_window_closed';
  return null;
}
export type SaveOfferKind = 'skip' | 'reschedule' | 'pause';
export function assertRetention(config: SubscriptionCareConfig): void {
  const policy = config.retention;
  const kinds: readonly SaveOfferKind[] = ['skip', 'reschedule', 'pause'];
  if (!policy || !policy.offerByReason || typeof policy.offerByReason !== 'object' || Array.isArray(policy.offerByReason)
    || !kinds.includes(policy.defaultOffer) || Object.entries(policy.offerByReason).some(([reason, kind]) =>
      !config.retentionReasons.includes(reason) || !kinds.includes(kind))
    || policy.pausePreset !== undefined && !config.pausePresets?.allowed.includes(policy.pausePreset)) {
    throw new Error('starter_retention_configuration_invalid');
  }
}
export function saveOfferKind(reason: string, config: SubscriptionCareConfig): SaveOfferKind {
  return Object.hasOwn(config.retention.offerByReason, reason) ? config.retention.offerByReason[reason]! : config.retention.defaultOffer;
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
