import type { Locale, Localized } from './config.ts';

export type RecoveryState = 'login_required' | 'unavailable' | 'method_unavailable'
  | 'awaiting_confirmation' | 'authorized_retry' | 'recovered' | 'exhausted' | 'support';
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
export function assertRecoveryConfiguration(config: RecoveryConfiguration | undefined): void {
  if (config === undefined) return;
  if (!config?.states || !config.message) throw new Error('starter_recovery_configuration_invalid');
  for (const section of [config.states, config.message]) {
    for (const key of Object.keys(section)) {
      const item = (section as Record<string, Localized>)[key];
      if (!item || (['en', 'pl'] as Locale[]).some(locale => typeof item[locale] !== 'string' || !item[locale].trim())) {
        throw new Error('starter_recovery_configuration_invalid');
      }
    }
  }
  if (Object.keys(config.states).sort().join() !== Object.keys(demoRecoveryConfiguration.states).sort().join()
    || Object.keys(config.message).sort().join() !== Object.keys(demoRecoveryConfiguration.message).sort().join()) {
    throw new Error('starter_recovery_configuration_invalid');
  }
}
