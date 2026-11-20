import type { Pool } from 'pg';
import { readCheckoutRecoveryReminderObservation } from '@openlup/platform/commerce/server';
import type { SettingsAppBindings } from '@openlup/platform/operations/server';
import { checkoutWavePolicy } from './acquisition-policy.ts';
import { assertConfig } from '../shared/config.ts';
import { configurations, selectConfiguration } from './store.config.ts';

export function createSettingsBindings({ db, configuration }: {
  db?: Pool; configuration?: string;
}): SettingsAppBindings {
  if (configuration !== undefined && !Object.hasOwn(configurations, configuration)) {
    return { configurationIds: Object.keys(configurations) };
  }
  const config = selectConfiguration(configuration);
  return {
    stockSourceKey: `starter-demo:${config.id}`,
    file: {
      configuration: config.id,
      validate: () => assertConfig(config),
      entries: {
        'offer.freeShippingFromMinor': { value: config.offer.freeShippingFromMinor },
        'offer.subscriptionDiscountBps': { value: config.offer.subscriptionDiscountBps },
        'purchase.reservationMinutes': { value: config.purchase.reservationMinutes },
        'subscriptionCreation.editWindowHours': { value: config.subscriptionCreation.editWindowHours },
        'subscriptionOffers.deliveryCycles': { value: config.subscriptionOffers },
        'subscriptions.lifecycleNoticeRetryBudget': { value: config.renewal.subscriptionCare.dispatch.maxAttempts },
        inventory_renewal_protection: { value: config.inventory.renewalProtection, location: { file: 'owned/store.config.ts', symbol: 'inventory.renewalProtection' } },
        checkout_recovery_reminders: { value: config.checkoutRecoveryReminders, location: { file: 'owned/store.config.ts', symbol: 'checkoutRecoveryReminders' } },
      },
    },
    readers: db ? {
      checkout_recovery_reminders: () => readCheckoutRecoveryReminderObservation(db, checkoutWavePolicy),
    } : {},
  };
}
