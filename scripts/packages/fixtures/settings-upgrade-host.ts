import type { Pool } from 'pg';
import { z } from 'zod';
import { readCheckoutRecoveryReminderObservation } from '@openlup/platform/commerce/server';
import type { SettingsAppBindings, SettingsFileEntry } from '@openlup/platform/operations/server';
import { checkoutWavePolicy } from '../../../examples/neutral-store/owned/acquisition-policy.ts';
import { assertConfig } from '../../../examples/neutral-store/shared/config.ts';
import { configurations, selectConfiguration } from '../../../examples/neutral-store/owned/store.config.ts';

export function createSettingsBindings({ db, configuration }: {
  db?: Pool; configuration?: string;
}): SettingsAppBindings {
  if (configuration !== undefined && !Object.hasOwn(configurations, configuration)) {
    return { configurationIds: Object.keys(configurations) };
  }
  const config = selectConfiguration(configuration);
  const file = 'owned/store.config.ts';
  const entries: Record<string, SettingsFileEntry> = {
    'offer.freeShippingFromMinor': { value: config.offer?.freeShippingFromMinor, location: { file, symbol: 'offer.freeShippingFromMinor' },
      descriptor: {
        domain: 'shipping',
        goal: "Set the free shipping threshold in currency minor units.",
        schema: z.number().int().min(0).max(2147483647).describe(
          "assertConfig checks whole minor units from 0 through 2147483647.",
        ),
        fallback: 1000,
        whyThisDefault: "Both samples set the threshold to 1000 minor units.",
        effect: {
          appliesTo: "The starter uses the deployed threshold in estimates. The default quote resolver uses it once the shipping policy takes effect.",
          frozenOn: ["The order draft saves the quote's shipping terms when present."],
          impact: 'customer-promise',
        },
      },
    },
    'offer.subscriptionDiscountBps': { value: config.offer?.subscriptionDiscountBps, location: { file, symbol: 'offer.subscriptionDiscountBps' },
      descriptor: {
        domain: 'pricing',
        goal: "Set the subscription discount in basis points.",
        schema: z.number().int().min(0).describe(
          "assertConfig first checks whole basis points from 0 through 10000. Startup and the install seed require a rounded subscription unit price of 1 through 2147483647 minor units. A 10000-basis-point discount produces zero.",
        ),
        fallback: 500,
        whyThisDefault: "Both samples set a 500-basis-point discount.",
        effect: {
          appliesTo: "The starter uses the deployed discount in subscription estimates. Initial installation seeds the native price policy from this value.",
          frozenOn: ["The saved checkout quote includes the quoted unit price."],
          impact: 'customer-promise',
        },
      },
    },
    'purchase.reservationMinutes': { value: config.purchase?.reservationMinutes, location: { file, symbol: 'purchase.reservationMinutes' },
      descriptor: {
        domain: 'commerce',
        goal: "Set the checkout reservation lifetime in minutes.",
        schema: z.number().int().min(1).describe(
          "assertConfig checks that the duration is a positive safe integer.",
        ),
        fallback: 30,
        whyThisDefault: "Both samples set a 30-minute duration.",
        effect: {
          appliesTo: "The starter calculates checkout hold expiry from the deployed duration. The recovery runtime uses the configured duration for its expiry calculation.",
          frozenOn: ["The reservation row records the expiry assigned at creation."],
          impact: 'customer-promise',
        },
      },
    },
    'subscriptionCreation.editWindowHours': { value: config.subscriptionCreation?.editWindowHours, location: { file, symbol: 'subscriptionCreation.editWindowHours' },
      descriptor: {
        domain: 'subscriptions',
        goal: "Set how many hours before a renewal customers can edit a newly created subscription (edit cutoff, change deadline, activation window).",
        schema: z.number().int().min(1).max(720),
        examples: [{ value: 48 }],
        fallback: 72,
        defaultBasis: { kind: 'reference-code' },
        whyThisDefault: "The starter sets a 72-hour edit window.",
        effect: {
          appliesTo: "The starter supplies the deployed edit window at native subscription activation.",
          frozenOn: ["The activation writes the window on the new subscription row."],
          impact: 'customer-promise',
        },
      },
    },
    'subscriptionOffers.deliveryCycles': { value: config.subscriptionOffers, location: { file, symbol: 'subscriptionOffers' },
      descriptor: {
        domain: 'subscriptions',
        goal: "Choose the allowed delivery interval and default cadence for subscriptions.",
        schema: z.looseObject({}).describe(
          "assertSubscriptionOffer checks days as a nonempty set of distinct integers from 1 through 3660 or a range within those bounds with an integer step from 1 through 2147483647. The default must be in days and in checkoutDays when supplied. assertQuoteConfiguration requires the classic offer to include the graduation cadence.",
        ),
        fallback: { days: { kind: "set", values: [28, 56] }, defaultDays: 28 },
        whyThisDefault: "The samples default to 28 days; one also allows 56 days and the other allows 14 and 56 days.",
        effect: {
          appliesTo: "A fresh subscription checkout checks the deployed classic offer. Starter terms admission checks cadence against the offer for the edit's mode.",
          frozenOn: ["A saved starter-pack quote records the graduation cadence captured at checkout."],
          impact: 'customer-promise',
        },
      },
    },
    'subscriptions.lifecycleNoticeRetryBudget': { value: config.renewal?.subscriptionCare?.dispatch?.maxAttempts,
      location: { file: 'owned/renewal.config.ts', symbol: 'subscriptionCare.dispatch.maxAttempts' },
      descriptor: {
        domain: 'subscriptions',
        goal: "Set the retry budget for dunning and event or reminder dispatch.",
        schema: z.number().int().min(1).max(2147483647).describe(
          "assertSubscriptionCare checks the budget as an integer from 1 through 2147483647.",
        ),
        fallback: 6,
        whyThisDefault: "The starter sets six attempts.",
        effect: {
          appliesTo: "On the next scheduled run using this config, the budget limits dunning claims and filters the event and reminder dispatch query. At-risk and operator notices run outside this cap.",
          frozenOn: [],
          impact: 'operations',
        },
      },
    },
    inventory_renewal_protection: { value: config.inventory?.renewalProtection, location: { file, symbol: 'inventory.renewalProtection' } },
    checkout_recovery_reminders: { value: config.checkoutRecoveryReminders, location: { file, symbol: 'checkoutRecoveryReminders' } },
  };
  return {
    stockSourceKey: `local-demo:${config.id}`,
    file: {
      configuration: config.id,
      validate() {
        assertConfig(config);
        selectConfiguration(config.id);
      },
      entries: Object.fromEntries(Object.entries(entries).filter(([, entry]) => entry.descriptor !== undefined || entry.value !== undefined)),
    },
    readers: db ? {
      checkout_recovery_reminders: () => readCheckoutRecoveryReminderObservation(db, checkoutWavePolicy),
    } : {},
  };
}
