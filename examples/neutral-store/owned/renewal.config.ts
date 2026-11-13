import type { RenewalConfig, SubscriptionCareConfig } from '../shared/renewal-config.ts';
import { renewalNoticeCopy } from './renewal-copy.ts';

export function demoRenewalConfig(configuration: string): RenewalConfig {
  return { subscriptionCare: demoSubscriptionCare(), enabled: false, retryBackoffHours: [24, 48, 72], population: `demo:${configuration}`, cadenceSeconds: 90,
    batchLimit: 10, leaseSeconds: 180, sandbox: { initial: 'declined', retry: 'succeeded' },
    recovery: { activeGraceSeconds: 21600, exhaustedTtlSeconds: 86400 },
    notices: { locale: 'en', countryLocales: {}, copy: renewalNoticeCopy } };
}


/** Neutral demonstration timing; construction starts no scheduler. Winback keeps its native default consent gate ON. */
export function demoSubscriptionCare(): SubscriptionCareConfig {
  return { enabled: true, batchLimit: 25, leaseSeconds: 180, recovered: { windowSeconds: 172800 },
    terms: { pauseDays: 14, pauseMonths: 1, slideMinDays: 3, slideMaxDays: 60,
      orderNowDelayMinutes: 5, reactivateDelayDays: 2 },
    retentionReasons: ['too_much_product', 'delivery_issue', 'too_expensive', 'not_a_good_fit', 'other'],
    rescheduleOfferDays: 14,
    dispatch: { leaseSeconds: 60, maxAttempts: 6, transientBackoffSeconds: 900 },
    notices: { renewalMinSeconds: 259200, renewalMaxSeconds: 432000, ordinaryFreshnessSeconds: 432000,
      starterFreshnessSeconds: 86400, pauseWindowSeconds: 259200, atRiskMinDays: 2, atRiskMaxDays: 5,
      atRiskMaxDaysPerCause: 2, operatorLeaseSeconds: 300, operatorMaxAttempts: 6,
      operatorHorizonSeconds: 82800, operatorTransientBackoffSeconds: 600 } };
}


/** Fictional account choices; a preference does not activate a provider or payment instrument. */
export const accountPreferencePolicy = {
  methods: { instant: 'demo-instant', card: 'demo-card', transfer: 'demo-transfer' },
  providers: { warehouse: 'demo-warehouse', carrier: 'demo-carrier', manual: 'demo-manual', simulator: 'demo-simulator' },
};
