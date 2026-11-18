import { assertLocalized, configuredLocales, type Locale, type Localized } from './locales.ts';

export type RecoveryState = 'login_required' | 'unavailable' | 'method_unavailable'
  | 'awaiting_confirmation' | 'authorized_retry' | 'recovered' | 'exhausted' | 'support';
// Independent required-key inventory: validation never derives keys from a translation registry.
const RECOVERY_STATES: readonly RecoveryState[] = ['login_required', 'unavailable', 'method_unavailable',
  'awaiting_confirmation', 'authorized_retry', 'recovered', 'exhausted', 'support'];
const RECOVERY_MESSAGE_KEYS = ['subject', 'body', 'expiryLabel'] as const;
export interface RecoveryConfiguration {
  states: Record<RecoveryState, Localized>;
  message: { subject: Localized; body: Localized; expiryLabel: Localized };
}
export const demoRecoveryConfiguration: RecoveryConfiguration = {
  states: {
    login_required: { en: 'Sign in to continue this payment recovery.', pl: 'Zaloguj się, aby kontynuować naprawę płatności.' },
    unavailable: { en: 'This recovery link is unavailable.', pl: 'Ten link do naprawy płatności jest niedostępny.' },
    method_unavailable: { en: 'A usable saved payment method is required. Contact support.', pl: 'Potrzebna jest aktywna zapisana metoda płatności. Skontaktuj się z obsługą.' },
    awaiting_confirmation: { en: 'Confirm retry of the original unpaid payment.', pl: 'Potwierdź ponowienie pierwotnej niezapłaconej płatności.' },
    authorized_retry: { en: 'Retry authorized. Payment confirmation is pending.', pl: 'Ponowienie zatwierdzone. Oczekiwanie na potwierdzenie płatności.' },
    recovered: { en: 'The original payment is confirmed recovered.', pl: 'Potwierdzono odzyskanie pierwotnej płatności.' },
    exhausted: { en: 'Automatic retries ended. You may authorize recovery of the same payment.', pl: 'Automatyczne próby zakończone. Możesz zatwierdzić naprawę tej samej płatności.' },
    support: { en: 'Contact support if you cannot continue.', pl: 'Jeśli nie możesz kontynuować, skontaktuj się z obsługą.' },
  },
  message: {
    subject: { en: 'Payment recovery', pl: 'Naprawa płatności' },
    body: { en: 'Sign in to review and repair your unpaid subscription payment.', pl: 'Zaloguj się, aby sprawdzić i naprawić niezapłaconą płatność subskrypcji.' },
    expiryLabel: { en: 'Link expires', pl: 'Link wygasa' },
  },
};
export function assertRecoveryConfiguration(config: RecoveryConfiguration | undefined, locales: readonly Locale[] = configuredLocales): void {
  // The default recovery copy is validated against the same inventory.
  const value = config ?? demoRecoveryConfiguration;
  if (!value?.states || !value.message) throw new Error('starter_recovery_configuration_invalid');
  const inventory = { states: RECOVERY_STATES, message: RECOVERY_MESSAGE_KEYS } as const;
  for (const section of ['states', 'message'] as const) {
    for (const key of inventory[section]) {
      assertLocalized((value[section] as Record<string, Localized>)[key], locales, `recovery.${section}.${key}`);
    }
    if (Object.keys(value[section]).sort().join() !== [...inventory[section]].sort().join()) {
      throw new Error('starter_recovery_configuration_invalid');
    }
  }
}
