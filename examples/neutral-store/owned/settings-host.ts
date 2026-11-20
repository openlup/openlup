import type { Pool } from 'pg';
import { z } from 'zod';
import { readCheckoutRecoveryReminderObservation } from '@openlup/platform/commerce/server';
import type { SettingsAppBindings, SettingsFileEntry } from '@openlup/platform/operations/server';
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
  const entries: Record<string, SettingsFileEntry> = {
    'offer.freeShippingFromMinor': {
      value: config.offer?.freeShippingFromMinor,
      location: { file, symbol: 'offer.freeShippingFromMinor' },
      descriptor: {
        domain: 'shipping',
        goal: "Set the free shipping threshold in currency minor units.",
        schema: z.number().int().min(0).max(2147483647).describe(
          "assertConfig checks whole minor units from 0 through 2147483647.",
        ),
        effect: {
          appliesTo: "The starter uses the deployed threshold in estimates. The default quote resolver uses it once the shipping policy takes effect.",
          frozenOn: ["The order draft saves the quote's shipping terms when present."],
          impact: 'customer-promise',
        },
      },
    },
    'offer.subscriptionDiscountBps': {
      value: config.offer?.subscriptionDiscountBps,
      location: { file, symbol: 'offer.subscriptionDiscountBps' },
      descriptor: {
        domain: 'pricing',
        goal: "Set the subscription discount in basis points.",
        schema: z.number().int().min(0).describe(
          "assertConfig first checks whole basis points from 0 through 10000. Startup and the install seed require a rounded subscription unit price of 1 through 2147483647 minor units. A 10000-basis-point discount produces zero.",
        ),
        effect: {
          appliesTo: "The starter uses the deployed discount in subscription estimates. Initial installation seeds the native price policy from this value.",
          frozenOn: ["The saved checkout quote includes the quoted unit price."],
          impact: 'customer-promise',
        },
      },
    },
    'purchase.reservationMinutes': {
      value: config.purchase?.reservationMinutes,
      location: { file, symbol: 'purchase.reservationMinutes' },
      descriptor: {
        domain: 'commerce',
        goal: "Set the checkout reservation lifetime in minutes.",
        schema: z.number().int().min(1).describe(
          "assertConfig checks that the duration is a positive safe integer.",
        ),
        effect: {
          appliesTo: "The starter calculates checkout hold expiry from the deployed duration. The recovery runtime uses the configured duration for its expiry calculation.",
          frozenOn: ["The reservation row records the expiry assigned at creation."],
          impact: 'customer-promise',
        },
      },
    },
    'subscriptionCreation.editWindowHours': {
      value: config.subscriptionCreation?.editWindowHours,
      location: { file, symbol: 'subscriptionCreation.editWindowHours' },
      descriptor: {
        domain: 'subscriptions',
        goal: "Set how many hours before a renewal customers can edit a newly created subscription (edit cutoff, change deadline, activation window).",
        schema: z.number().int().min(1).max(720),
        examples: [{ value: 48 }],
        effect: {
          appliesTo: "The starter supplies the deployed edit window at native subscription activation.",
          frozenOn: ["The activation writes the window on the new subscription row."],
          impact: 'customer-promise',
        },
      },
    },
    'subscriptionOffers.deliveryCycles': {
      value: config.subscriptionOffers,
      location: { file, symbol: 'subscriptionOffers' },
      descriptor: {
        domain: 'subscriptions',
        goal: "Choose the allowed delivery interval and default cadence for subscriptions.",
        schema: z.looseObject({}).describe(
          "assertSubscriptionOffer checks days as a nonempty set of distinct integers from 1 through 3660 or a range within those bounds with an integer step from 1 through 2147483647. The default must be in days and in checkoutDays when supplied. assertQuoteConfiguration requires the classic offer to include the graduation cadence.",
        ),
        effect: {
          appliesTo: "A fresh subscription checkout checks the deployed classic offer. Starter terms admission checks cadence against the offer for the edit's mode.",
          frozenOn: ["A saved starter-pack quote records the graduation cadence captured at checkout."],
          impact: 'customer-promise',
        },
      },
    },
    'subscriptions.lifecycleNoticeRetryBudget': {
      value: config.renewal?.subscriptionCare?.dispatch?.maxAttempts,
      location: { file: 'owned/renewal.config.ts', symbol: 'subscriptionCare.dispatch.maxAttempts' },
      descriptor: {
        domain: 'subscriptions',
        goal: "Set the retry budget for dunning and event or reminder dispatch.",
        schema: z.number().int().min(1).max(2147483647).describe(
          "assertSubscriptionCare checks the budget as an integer from 1 through 2147483647.",
        ),
        effect: {
          appliesTo: "On the next scheduled run using this config, the budget limits dunning claims and filters the event and reminder dispatch query. At-risk and operator notices run outside this cap.",
          frozenOn: [],
          impact: 'operations',
        },
      },
    },
    'renewal.retryBackoffHours': {
      value: config.renewal?.retryBackoffHours,
      location: { file: 'owned/renewal.config.ts', symbol: 'retryBackoffHours' },
      descriptor: {
        domain: 'subscriptions',
        goal: "Set the hours between payment retries after a failed renewal charge (payment retry policy, dunning schedule, retry ladder, backoff).",
        schema: z.array(z.number().int().min(0).max(2147483647)).length(3).describe(
          "assertRenewalConfig checks exactly three whole-hour delays from 0 through 2147483647.",
        ),
        effect: {
          appliesTo: "The sandbox renewal job reads the deployed retry ladder when it schedules retries after a failed charge.",
          frozenOn: ["A waiting retry obligation keeps its scheduled retry time."],
          impact: 'operations',
        },
      },
    },
    'offer.shippingMinor': {
      value: config.offer?.shippingMinor,
      location: { file, symbol: 'offer.shippingMinor' },
      descriptor: {
        domain: 'shipping',
        goal: "Set the flat shipping price in currency minor units (flat shipping, delivery fee, shipping cost).",
        schema: z.number().int().min(0).max(2147483647).describe(
          "assertConfig checks whole minor units from 0 through 2147483647.",
        ),
        effect: {
          appliesTo: "The deployed flat amount is used by fresh storefront estimates and by the default resolver for new quotes when the shipping policy is effective.",
          frozenOn: ["Saved checkout quotes keep their quoted shipping amounts and terms."],
          impact: 'money',
        },
      },
    },
    'purchase.tax.vatRateBps': {
      value: config.purchase?.tax?.vatRateBps,
      location: { file, symbol: 'purchase.tax.vatRateBps' },
      descriptor: {
        domain: 'pricing',
        goal: "Set the VAT rate in basis points (tax rate, sales tax).",
        schema: z.number().int().min(0).max(10000).describe(
          "assertConfig checks whole basis points from 0 through 10000.",
        ),
        effect: {
          appliesTo: "Checkout and subscription editing use the deployed tax rate when creating a new quote.",
          frozenOn: ["Saved checkout quotes keep their tax calculation."],
          impact: 'money',
        },
      },
    },
    'offer.minUnits': {
      value: config.offer?.minUnits,
      location: { file, symbol: 'offer.minUnits' },
      descriptor: {
        domain: 'checkout',
        goal: "Set the minimum quantity per order (quantity limit, checkout limit, minimum units).",
        schema: z.number().int().min(1).max(config.offer.maxUnits).describe(
          "assertConfig checks a whole quantity of at least 1 and no greater than offer.maxUnits.",
        ),
        effect: {
          appliesTo: "Cart validation reads the deployed minimum when admitting a new checkout quote.",
          frozenOn: [],
          impact: 'customer-promise',
        },
      },
    },
    'offer.maxUnits': {
      value: config.offer?.maxUnits,
      location: { file, symbol: 'offer.maxUnits' },
      descriptor: {
        domain: 'checkout',
        goal: "Set the maximum quantity per order (quantity limit, checkout limit, maximum units).",
        schema: z.number().int().min(config.offer.minUnits).max(100).describe(
          "assertConfig checks a whole quantity at least as large as offer.minUnits and no greater than 100.",
        ),
        effect: {
          appliesTo: "Cart validation reads the deployed maximum when admitting a new checkout quote.",
          frozenOn: [],
          impact: 'customer-promise',
        },
      },
    },
    'purchase.attemptLimits': {
      value: config.purchase?.attemptLimits,
      location: { file, symbol: 'purchase.attemptLimits' },
      descriptor: {
        domain: 'checkout',
        goal: "Set the checkout attempt rate limits per requester and per email (rate limit, throttling, abuse protection).",
        schema: z.looseObject({
          windowMs: z.number().int().min(1),
          maxPerRequester: z.number().int().min(1),
          maxPerEmail: z.number().int().min(1),
          retentionMs: z.number().int().min(1),
          maxEntries: z.number().int().min(1),
        }).partial().catchall(z.number().int().min(1)).describe(
          "assertConfig checks positive safe integers for the attempt limits and requires retentionMs to be at least windowMs.",
        ),
        effect: {
          appliesTo: "The starter's checkout limiter and attempt bindings use the deployed quotas, windows and capacity when a process initializes them.",
          frozenOn: [],
          impact: 'operations',
        },
      },
    },
    'renewal.subscriptionCare.terms': {
      value: config.renewal?.subscriptionCare?.terms,
      location: { file: 'owned/renewal.config.ts', symbol: 'subscriptionCare.terms' },
      descriptor: {
        domain: 'subscriptions',
        goal: "Set subscription pause lengths, reschedule (slide) limits and order-now and reactivation delays (pause duration, skip, postpone delivery).",
        schema: z.looseObject({
          pauseDays: z.number().int().min(1).max(2147483647),
          pauseMonths: z.number().int().min(1).max(2147483647),
          slideMinDays: z.number().int().min(1).max(2147483647),
          slideMaxDays: z.number().int().min(1).max(2147483647),
          orderNowDelayMinutes: z.number().int().min(1).max(2147483647),
          reactivateDelayDays: z.number().int().min(1).max(2147483647),
        }).partial().catchall(z.number().int().min(1).max(2147483647)).describe(
          "assertSubscriptionCare checks whole values from 1 through 2147483647 and requires slideMinDays to be at most slideMaxDays.",
        ),
        effect: {
          appliesTo: "The starter's subscription command handler passes the deployed lifecycle terms to native commands when handling new customer actions.",
          frozenOn: ["Applied pauses and scheduled cycles retain the dates computed by the completed action."],
          impact: 'customer-promise',
        },
      },
    },
    'renewal.subscriptionCare.pausePresets': {
      value: config.renewal?.subscriptionCare?.pausePresets,
      location: { file: 'owned/renewal.config.ts', symbol: 'subscriptionCare.pausePresets' },
      descriptor: {
        domain: 'subscriptions',
        goal: "Choose the pause options offered to subscribers and the default (pause presets, pause choices).",
        schema: z.looseObject({
          allowed: z.array(z.enum(['2_weeks', '1_month', 'indefinite'])).min(1).max(3),
          default: z.enum(['2_weeks', '1_month', 'indefinite']),
        }).describe(
          "assertSubscriptionCare requires nonempty, distinct choices from 2_weeks, 1_month and indefinite, including the default. assertRetention requires any configured retention preset to be allowed.",
        ),
        effect: {
          appliesTo: "The account page and pause command admission use the deployed presets when subscribers open the pause form or request a new pause.",
          frozenOn: [],
          impact: 'customer-promise',
        },
      },
    },
    'renewal.subscriptionCare.notices': {
      value: config.renewal?.subscriptionCare?.notices,
      location: { file: 'owned/renewal.config.ts', symbol: 'subscriptionCare.notices' },
      descriptor: {
        domain: 'subscriptions',
        goal: "Set the timing windows for renewal, pause and at-risk notices (notification timing, reminder window, upcoming renewal email).",
        schema: z.looseObject({
          renewalMinSeconds: z.number().int().min(1).max(2147483647),
          renewalMaxSeconds: z.number().int().min(1).max(2147483647),
          ordinaryFreshnessSeconds: z.number().int().min(1).max(2147483647),
          starterFreshnessSeconds: z.number().int().min(1).max(2147483647),
          pauseWindowSeconds: z.number().int().min(1).max(2147483647),
          atRiskMinDays: z.number().int().min(1).max(2147483647),
          atRiskMaxDays: z.number().int().min(1).max(2147483647),
          atRiskMaxDaysPerCause: z.number().int().min(1).max(2147483647),
          operatorLeaseSeconds: z.number().int().min(1).max(2147483647),
          operatorMaxAttempts: z.number().int().min(1).max(2147483647),
          operatorHorizonSeconds: z.number().int().min(1).max(2147483647),
          operatorTransientBackoffSeconds: z.number().int().min(1).max(2147483647),
        }).partial().catchall(z.number().int().min(1).max(2147483647)).describe(
          "assertSubscriptionCare checks whole values from 1 through 2147483647 and requires each renewal and at-risk minimum to be at most its maximum.",
        ),
        effect: {
          appliesTo: "The lifecycle notice job uses the deployed windows and operator delivery controls on its next run.",
          frozenOn: [],
          impact: 'operations',
        },
      },
    },
    'legal.returnsDays': {
      value: config.legal?.returnsDays,
      location: { file, symbol: 'legal.returnsDays' },
      descriptor: {
        domain: 'commerce',
        goal: "Set the returns period in days (return window, withdrawal period).",
        effect: {
          appliesTo: "The returns page displays the deployed period when rendered.",
          frozenOn: [],
          impact: 'customer-promise',
        },
      },
    },
    'offer.subscriptionRoundingQuantumMinor': {
      value: config.offer?.subscriptionRoundingQuantumMinor,
      location: { file, symbol: 'offer.subscriptionRoundingQuantumMinor' },
      descriptor: {
        domain: 'pricing',
        goal: "Set the rounding step for subscription prices in currency minor units (price rounding, rounding quantum).",
        schema: z.number().int().min(1).describe(
          "assertConfig checks a positive safe integer and requires each estimated subscription unit price to be from 1 through 2147483647 minor units.",
        ),
        effect: {
          appliesTo: "The starter uses the deployed rounding step for fresh estimates and reads it when seeding subscription price policy during installation.",
          frozenOn: ["Installed price policy and saved checkout quotes retain the pricing already recorded."],
          impact: 'money',
        },
      },
    },
    market: {
      value: {
        country: config.market.country,
        currency: config.market.currency,
        timezone: config.market.timezone,
      },
      location: { file, symbol: 'market' },
      descriptor: {
        domain: 'commerce',
        goal: "Set the store country, currency and time zone (market, region).",
        schema: z.looseObject({
          country: z.string().regex(/^[A-Z]{2}$/),
          currency: z.string().regex(/^[A-Z]{3}$/),
          timezone: z.string().regex(/\S/),
        }).describe(
          "assertConfig checks uppercase country and currency codes and a nonblank time zone, then checks whether Intl recognizes the time zone and the product currencies match.",
        ),
        effect: {
          appliesTo: "New quotes use the deployed country and currency, and new subscription editor renders format dates in the deployed time zone.",
          frozenOn: ["Saved checkout quotes retain their line tax country and currency."],
          impact: 'customer-promise',
        },
      },
    },
    'shipping.rateResolver': {
      value: undefined,
      location: { file: 'owned/quote-shipping.ts', symbol: 'createQuoteShipping' },
      descriptor: {
        domain: 'shipping',
        goal: "Change how shipping rates are calculated or connect a shipping carrier (carrier, shipping provider, courier, rate calculation).",
        effect: {
          appliesTo: "Checkout quote composition calls the deployed shipping resolver factory when creating a new quote.",
          frozenOn: ["Saved checkout quotes keep their shipping amounts and terms."],
          impact: 'money',
        },
      },
    },
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
      entries: Object.fromEntries(Object.entries(entries).filter(([, entry]) => entry.descriptor !== undefined || entry.value !== undefined)),
    },
    readers: db ? {
      checkout_recovery_reminders: () => readCheckoutRecoveryReminderObservation(db, checkoutWavePolicy),
    } : {},
  };
}
