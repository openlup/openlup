export interface RenewalNoticeText {
  paid: { subject: string; order: string; item: string; quantity: string; subtotal: string; discount: string; total: string };
  payment_failed: string; payment_expired: string; payment_recovery: string; payment_recovered: string;
  lifecycle: string; active: string; amount: string; retry: string; charge: string;
  repair: string; expires: string; unknown: string; address: string; addressApplied: string; addressNextParcel: string; status: string; minorUnits: string; cause: string;
  needsConfirmation: string; cannotRecur: string; methodDead: string; methodDataInvalid: string; methodMissing: string;
}

/** Non-secret application values; the installer and host consume this same input. */
export interface RenewalConfig {
  enabled: boolean;
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
  if (!config || typeof config.enabled !== 'boolean' || typeof config.population !== 'string'
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
}
