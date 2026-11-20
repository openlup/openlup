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
  const file = 'owned/store.config.ts';
  const entries = {
    'offer.freeShippingFromMinor': { value: config.offer?.freeShippingFromMinor, location: { file, symbol: 'offer.freeShippingFromMinor' } },
    'offer.subscriptionDiscountBps': { value: config.offer?.subscriptionDiscountBps, location: { file, symbol: 'offer.subscriptionDiscountBps' } },
    'purchase.reservationMinutes': { value: config.purchase?.reservationMinutes, location: { file, symbol: 'purchase.reservationMinutes' } },
    'subscriptionCreation.editWindowHours': { value: config.subscriptionCreation?.editWindowHours, location: { file, symbol: 'subscriptionCreation.editWindowHours' } },
    'subscriptionOffers.deliveryCycles': { value: config.subscriptionOffers, location: { file, symbol: 'subscriptionOffers' } },
    'subscriptions.lifecycleNoticeRetryBudget': { value: config.renewal?.subscriptionCare?.dispatch?.maxAttempts,
      location: { file: 'owned/renewal.config.ts', symbol: 'subscriptionCare.dispatch.maxAttempts' } },
    inventory_renewal_protection: { value: config.inventory?.renewalProtection, location: { file, symbol: 'inventory.renewalProtection' } },
    checkout_recovery_reminders: { value: config.checkoutRecoveryReminders, location: { file, symbol: 'checkoutRecoveryReminders' } },
  };
  return {
    stockSourceKey: `starter-demo:${config.id}`,
    file: {
      configuration: config.id,
      validate() {
        assertConfig(config);
        selectConfiguration(config.id);
      },
      entries: Object.fromEntries(Object.entries(entries).filter(([, entry]) => entry.value !== undefined)),
    },
    readers: db ? {
      checkout_recovery_reminders: () => readCheckoutRecoveryReminderObservation(db, checkoutWavePolicy),
    } : {},
  };
}
