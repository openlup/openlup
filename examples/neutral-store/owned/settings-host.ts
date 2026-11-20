import type { Pool } from 'pg';
import { readCheckoutRecoveryReminderObservation } from '@openlup/platform/commerce/server';
import type { SettingsAppBindings } from '@openlup/platform/operations/server';
import { checkoutWavePolicy } from './acquisition-policy.ts';
import { configurations, selectConfiguration } from './store.config.ts';

export function createSettingsBindings({ db, configuration }: {
  db?: Pool; configuration?: string;
}): SettingsAppBindings {
  if (configuration !== undefined && !Object.hasOwn(configurations, configuration)) {
    return { configurationIds: Object.keys(configurations) };
  }
  return {
    stockSourceKey: `starter-demo:${selectConfiguration(configuration).id}`,
    readers: db ? {
      checkout_recovery_reminders: () => readCheckoutRecoveryReminderObservation(db, checkoutWavePolicy),
    } : {},
  };
}
