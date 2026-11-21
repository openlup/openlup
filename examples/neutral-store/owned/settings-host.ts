import type { Pool } from 'pg';
import { z } from 'zod';
import { readCheckoutRecoveryReminderObservation } from '@openlup/platform/commerce/server';
import type { SettingsAppBindings, SettingsFileEntry } from '@openlup/platform/operations/server';
import { checkoutLinkPolicy, checkoutRecoverySchedule, checkoutWavePolicy, sandboxRecoveryPolicy } from './acquisition-policy.ts';
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
        goal: "Choose allowed subscription delivery intervals, default cadence, unit and line limits, and per-SKU quantity rules for classic and sized offers.",
        schema: (() => {
          const positiveInt32 = z.number().int().min(1).max(2147483647);
          const numbersDomain = z.union([
            z.strictObject({ kind: z.literal('set'), values: z.array(positiveInt32).min(1) }),
            z.strictObject({ kind: z.literal('range'), min: positiveInt32, max: positiveInt32, step: positiveInt32 }),
          ]);
          const skuOfferRule = z.strictObject({ days: numbersDomain, quantities: numbersDomain });
          const subscriptionOfferSchema = z.strictObject({
            days: numbersDomain,
            checkoutDays: numbersDomain.optional(),
            preferredDays: numbersDomain.optional(),
            checkoutMinimumBaseUnits: positiveInt32.optional(),
            defaultDays: positiveInt32,
            minimumBaseUnits: positiveInt32,
            maximumUnits: positiveInt32,
            maximumBaseLines: positiveInt32,
            maximumAddonLines: positiveInt32,
            bySku: z.record(z.string().min(1), z.array(skuOfferRule).min(1)),
          });
          return z.strictObject({
            classic: subscriptionOfferSchema,
            sized: subscriptionOfferSchema,
          });
        })().describe(
          "assertSubscriptionOffer checks days as a nonempty set of distinct integers from 1 through 3660 or a range within those bounds with an integer step from 1 through 2147483647. The default must be in days and in checkoutDays when supplied, maximumUnits must be at least minimumBaseUnits, line counts and SKU quantities stay within checkout bounds (50 lines, 99 units per line), and SKU cadences do not repeat across rules. assertQuoteConfiguration requires the classic offer to include the graduation cadence.",
        ),
        effect: {
          appliesTo: "Fresh subscription checkouts check the deployed classic offer (cadence, unit/line limits and per-SKU rules). Starter terms admission checks edits against the classic or sized offer for the edit's mode.",
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
        schema: z.array(z.number().int().min(1).max(2147483647)).length(3).describe(
          "assertRenewalConfig checks exactly three whole-hour delays from 1 through 2147483647.",
        ),
        effect: {
          appliesTo: "The starter's renewal retry driver reads the deployed 3-step ladder when scheduling retries after a failed charge. Provider-recorded payment failures applied in SQL still use the fixed 24, 72 and 168 hour ladder; see subscriptions.retrySchedule.",
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
        schema: z.strictObject({
          windowMs: z.number().int().min(1),
          maxPerRequester: z.number().int().min(1),
          maxPerEmail: z.number().int().min(1),
          retentionMs: z.number().int().min(1),
          maxEntries: z.number().int().min(1),
        }).describe(
          "assertConfig checks positive safe integers for the attempt limits and requires retentionMs to be at least windowMs.",
        ),
        effect: {
          appliesTo: "The starter's checkout limiter and attempt bindings use the deployed quotas, windows and capacity when a process initializes them. Warning: this is an abuse-protection threshold — raising quotas weakens brute-force and card-testing throttling, while setting them too low blocks legitimate buyers behind shared IPs. The built-in starter limiter is in-memory per process and resets on restart.",
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
    'market.localePolicy': {
      value: {
        locales: config.market.locales,
        defaultLocale: config.market.defaultLocale,
      },
      location: { file: 'owned/market.config.ts', symbol: 'market' },
      descriptor: {
        domain: 'commerce',
        goal: "Choose supported storefront and notice languages and the default locale (locale policy, languages, i18n, default language).",
        schema: z.strictObject({
          locales: z.array(z.enum(['en', 'pl'])).min(1).max(2),
          defaultLocale: z.enum(['en', 'pl']),
        }).describe(
          "assertLocaleMarket checks a nonempty list of distinct supported platform locales (en, pl) and requires defaultLocale to be included in locales. assertStarterCopy checks that every configured locale has nonblank copy.",
        ),
        effect: {
          appliesTo: "Storefront routing, copy validation, and locale fallback use the deployed language list and default locale for new requests and renders.",
          frozenOn: ["Recorded customer locales and saved notice or evidence records retain the locale captured when they were written."],
          impact: 'customer-promise',
        },
      },
    },
    'purchase.contact': {
      value: config.purchase?.contact,
      location: { file, symbol: 'purchase.contact' },
      descriptor: {
        domain: 'commerce',
        goal: "Set the default acquisition source and lifecycle stage assigned to newly created guest contacts (guest contact, lead stage, CRM contact defaults).",
        schema: z.strictObject({
          acquisitionSource: z.string().regex(/\S/).max(100),
          lifecycleStage: z.enum(['lead', 'customer', 'inactive']),
        }).describe(
          "assertConfig checks a nonblank acquisitionSource of at most 100 characters and lifecycleStage from lead, customer, or inactive.",
        ),
        effect: {
          appliesTo: "Checkout uses the deployed acquisitionSource and lifecycleStage when creating a new guest contact record.",
          frozenOn: ["Existing matched contacts keep their recorded acquisitionSource and lifecycleStage."],
          impact: 'operations',
        },
      },
    },
    'returns.reasons': {
      value: config.returns?.reasons?.map(reason => reason.code),
      location: { file, symbol: 'returns.reasons' },
      descriptor: {
        domain: 'commerce',
        goal: "Choose the subset of return reason codes offered to customers (return reasons, RMA reasons, withdrawal reasons).",
        schema: z.array(z.enum(['damaged', 'wrong_item', 'not_as_described', 'pet_refused', 'changed_mind', 'other'])).min(1).max(6).describe(
          "assertConfig checks a nonempty list of distinct nonblank return reason codes. Native SQL return creation enforces the fixed six-code vocabulary (damaged, wrong_item, not_as_described, pet_refused, changed_mind, other); see commerce.returnReasons.",
        ),
        effect: {
          appliesTo: "The storefront returns form and starter return request schema admit only the deployed subset of return reason codes for new return requests.",
          frozenOn: ["Submitted return requests keep the reason code recorded at creation."],
          impact: 'customer-promise',
        },
      },
    },
    'orderControls.holdReasons': {
      value: config.orderControls?.holdReasons?.map(reason => reason.code),
      location: { file, symbol: 'orderControls.holdReasons' },
      descriptor: {
        domain: 'commerce',
        goal: "Choose the subset of manual order hold reason codes offered to operators (order holds, hold reasons, fulfillment hold).",
        schema: z.array(z.enum(['payment_not_succeeded', 'inventory_review', 'risk_review', 'address_review', 'fulfillment_exception', 'manual_support'])).min(1).max(6).describe(
          "assertConfig checks a nonempty list of distinct nonblank hold reason codes from the fixed six-code native vocabulary; see commerce.manualHoldReasons.",
        ),
        effect: {
          appliesTo: "The operator order-control UI and starter hold admission accept only the deployed subset of the six fixed hold reasons (see commerce.manualHoldReasons) when placing new holds.",
          frozenOn: ["Recorded order holds keep the reason code captured when they were placed."],
          impact: 'operations',
        },
      },
    },
    'checkout.initialPaymentWindow': {
      value: checkoutRecoverySchedule.initialTimeoutSeconds,
      location: { file: 'owned/acquisition-policy.ts', symbol: 'checkoutRecoverySchedule.initialTimeoutSeconds' },
      descriptor: {
        domain: 'checkout',
        goal: "Set how many seconds an unpaid checkout stays open before the recovery scheduler can expire or cancel it (checkout timeout, initial payment window, unpaid checkout expiry).",
        schema: z.number().int().min(1).max(2147483647).describe(
          "Positive 32-bit integer in seconds governing when the starter's checkout recovery runner treats an unpaid checkout as timed out.",
        ),
        effect: {
          appliesTo: "On its next run, the starter's checkout recovery scheduler applies the deployed timeout threshold to open unpaid checkouts when deciding whether they can be expired.",
          frozenOn: ["Already expired or completed checkouts keep their recorded terminal state."],
          impact: 'customer-promise',
        },
      },
    },
    'checkout.recoveryLinkPolicy': {
      value: {
        operatorLifetimeMs: checkoutLinkPolicy.operatorLifetimeMs,
        recoveryWindowMs: checkoutLinkPolicy.recoveryWindowMs,
        buyerLifetimeMs: sandboxRecoveryPolicy.buyerLifetimeMs,
      },
      location: { file: 'owned/acquisition-policy.ts', symbol: 'checkoutLinkPolicy' },
      descriptor: {
        domain: 'checkout',
        goal: "Set the lifetime of operator and buyer checkout recovery links and the overall recovery window in milliseconds (recovery link expiry, continuation link TTL, payment link lifetime).",
        schema: z.strictObject({
          operatorLifetimeMs: z.number().int().min(1),
          recoveryWindowMs: z.number().int().min(1),
          buyerLifetimeMs: z.number().int().min(1),
        }).describe(
          "Positive safe integers in milliseconds: checkoutLinkPolicy supplies operatorLifetimeMs and recoveryWindowMs, while sandboxRecoveryPolicy.buyerLifetimeMs supplies the buyer link lifetime.",
        ),
        effect: {
          appliesTo: "New operator recovery links and expired-checkout recovery checks read checkoutLinkPolicy (operatorLifetimeMs, recoveryWindowMs), while new buyer continuation links read sandboxRecoveryPolicy.buyerLifetimeMs.",
          frozenOn: ["Issued operator and buyer recovery links keep the expiry timestamp recorded when they were created."],
          impact: 'customer-promise',
        },
      },
    },
    'checkout.waveWindows': {
      value: {
        checkoutSeconds: checkoutWavePolicy.checkoutSeconds,
        recoverySeconds: checkoutWavePolicy.recoverySeconds,
        activitySeconds: checkoutWavePolicy.activitySeconds,
        firstOffsetSeconds: checkoutWavePolicy.firstOffsetSeconds,
        finalOffsetSeconds: checkoutWavePolicy.finalOffsetSeconds,
      },
      location: { file: 'owned/acquisition-policy.ts', symbol: 'checkoutWavePolicy' },
      descriptor: {
        domain: 'checkout',
        goal: "Set the checkout recovery wave windows, activity debounce, and fallback reminder offsets in seconds (recovery wave policy, abandoned checkout window, reminder fallback offsets).",
        schema: z.strictObject({
          checkoutSeconds: z.number().int().min(1).max(2147483647),
          recoverySeconds: z.number().int().min(1).max(2147483647),
          activitySeconds: z.number().int().min(1).max(2147483647),
          firstOffsetSeconds: z.number().int().min(1).max(2147483647),
          finalOffsetSeconds: z.number().int().min(1).max(2147483647),
        }).describe(
          "Whole seconds from 1 through 2147483647; firstOffsetSeconds must stay below finalOffsetSeconds, which must stay below checkoutSeconds.",
        ),
        effect: {
          appliesTo: "Checkout recovery wave scheduling uses checkoutSeconds, recoverySeconds and activitySeconds for new episodes. firstOffsetSeconds and finalOffsetSeconds act only as a fallback when no installed checkout_recovery_reminders row is present in the database.",
          frozenOn: ["Enqueued reminder events and pinned recovery episodes keep the schedule and timing captured when they were created."],
          impact: 'operations',
        },
      },
    },
    'renewal.subscriptionCare.retention': {
      value: config.renewal?.subscriptionCare ? {
        reasons: config.renewal.subscriptionCare.retentionReasons,
        ...config.renewal.subscriptionCare.retention,
        rescheduleOfferDays: config.renewal.subscriptionCare.rescheduleOfferDays,
      } : undefined,
      location: { file: 'owned/renewal.config.ts', symbol: 'subscriptionCare.retention' },
      descriptor: {
        domain: 'subscriptions',
        goal: "Configure cancellation reasons, save-offer mapping per reason, fallback offer, preselected pause preset, and reschedule offer days (retention flow, save offer, cancel reasons).",
        schema: z.strictObject({
          reasons: z.array(z.string().regex(/^[a-z][a-z0-9_]{0,119}$/)).min(1),
          offerByReason: z.record(z.string().regex(/^[a-z][a-z0-9_]{0,119}$/), z.enum(['skip', 'reschedule', 'pause'])),
          defaultOffer: z.enum(['skip', 'reschedule', 'pause']),
          pausePreset: z.enum(['2_weeks', '1_month', 'indefinite']).optional(),
          rescheduleOfferDays: z.number().int().min(1).max(2147483647),
        }).describe(
          "assertSubscriptionCare checks nonempty snake_case retention reasons and rescheduleOfferDays from 1 through 2147483647. assertRetention requires every offerByReason key to appear in reasons and any pausePreset to be allowed by renewal.subscriptionCare.pausePresets.",
        ),
        effect: {
          appliesTo: "The subscriber cancellation flow presents the deployed reasons, per-reason and fallback save offers, preselected pause preset, and reschedule target offset when a customer starts a new cancellation.",
          frozenOn: ["Completed skips, pauses, reschedules, and cancellations keep the actions already recorded."],
          impact: 'customer-promise',
        },
      },
    },
    'renewal.subscriptionCare.actions': {
      value: config.renewal?.subscriptionCare?.actions,
      location: { file: 'owned/renewal.config.ts', symbol: 'subscriptionCare.actions' },
      descriptor: {
        domain: 'subscriptions',
        goal: "Choose which self-service subscription actions are admitted for each subscription status and payment-blocker state (subscriber actions, self-service commands, lifecycle actions).",
        schema: (() => {
          const actionList = z.array(z.enum(['skip', 'slide', 'pause', 'resume', 'cancel', 'order_now', 'reactivate'])).max(7);
          return z.strictObject({
            active: actionList,
            paused: actionList,
            cancelled: actionList,
            whilePaymentBlocked: actionList,
            whilePaymentExpired: actionList,
          });
        })().describe(
          "assertSubscriptionCare checks distinct action names from skip, slide, pause, resume, cancel, order_now, and reactivate for active, paused, cancelled, whilePaymentBlocked, and whilePaymentExpired.",
        ),
        effect: {
          appliesTo: "The account portal and starter command admission check the deployed status and payment-blocker action lists when authorizing new customer subscription commands.",
          frozenOn: ["Completed commands replay their stored outcome without re-evaluating changed action lists."],
          impact: 'customer-promise',
        },
      },
    },
    'renewal.subscriptionCare.recovered.windowSeconds': {
      value: config.renewal?.subscriptionCare?.recovered?.windowSeconds,
      location: { file: 'owned/renewal.config.ts', symbol: 'subscriptionCare.recovered.windowSeconds' },
      descriptor: {
        domain: 'subscriptions',
        goal: "Set the time window in seconds for sending payment-recovered confirmation notices (payment recovered window, recovery confirmation cutoff, 48h window).",
        schema: z.number().int().min(1).max(2147483647).describe(
          "assertSubscriptionCare checks whole seconds from 1 through 2147483647 (default 172800 seconds, or 48 hours).",
        ),
        effect: {
          appliesTo: "On its next run, the subscription-care notice job evaluates pending payment-recovered confirmations against the deployed window.",
          frozenOn: ["Already dispatched payment-recovered confirmations keep their recorded delivery state."],
          impact: 'operations',
        },
      },
    },
    'renewal.recovery': {
      value: config.renewal?.recovery,
      location: { file: 'owned/renewal.config.ts', symbol: 'recovery' },
      descriptor: {
        domain: 'subscriptions',
        goal: "Set the grace period and exhausted-retry link lifetime in seconds for renewal payment recovery links (payment repair link TTL, renewal recovery grace).",
        schema: z.strictObject({
          activeGraceSeconds: z.number().int().min(1).max(2147483647),
          exhaustedTtlSeconds: z.number().int().min(1).max(2147483647),
        }).describe(
          "assertRenewalConfig checks whole seconds from 1 through 2147483647 for activeGraceSeconds and exhaustedTtlSeconds.",
        ),
        effect: {
          appliesTo: "New renewal payment-recovery links compute their expiry from activeGraceSeconds while retries remain and exhaustedTtlSeconds after retries are exhausted.",
          frozenOn: ["Issued renewal payment-recovery links keep the expiry timestamp recorded when they were created."],
          impact: 'customer-promise',
        },
      },
    },
    'renewal.notices.localePolicy': {
      value: config.renewal?.notices ? {
        locale: config.renewal.notices.locale,
        countryLocales: config.renewal.notices.countryLocales ?? {},
      } : undefined,
      location: { file: 'owned/renewal.config.ts', symbol: 'notices' },
      descriptor: {
        domain: 'subscriptions',
        goal: "Set the fallback language and country-to-locale mapping for renewal and lifecycle notices (notice language, email locale, country locale mapping).",
        schema: z.strictObject({
          locale: z.enum(['en', 'pl']),
          countryLocales: z.record(z.string().regex(/^[A-Z]{2}$/), z.enum(['en', 'pl'])),
        }).describe(
          "assertRenewalConfig checks a supported fallback locale (en, pl) and optional two-letter uppercase country codes mapped to supported locales.",
        ),
        effect: {
          appliesTo: "New renewal and subscription lifecycle notices resolve their language from countryLocales and fall back to locale when no country mapping applies.",
          frozenOn: ["Already generated or queued notices keep the locale rendered when they were created."],
          impact: 'customer-promise',
        },
      },
    },
    'subscriptionEditing.sizedPreferences': {
      value: config.subscriptionEditing?.sized ? {
        preferredSize: config.subscriptionEditing.sized.preferredSize,
        nominalSizes: config.subscriptionEditing.sized.nominalSizes,
        portionModes: config.subscriptionEditing.sized.portionModes,
      } : undefined,
      location: { file: 'owned/subscription-editing.ts', symbol: 'subscriptionEditing' },
      descriptor: {
        domain: 'subscriptions',
        goal: "Set preferred and nominal package sizes and portion-mode factors for sized subscription editing (sized portions, nominal sizes, portion factors).",
        schema: (() => {
          const portionMode = z.strictObject({
            mode: z.string().min(1),
            factor: z.number().gt(0),
          });
          return z.strictObject({
            preferredSize: z.number().int().min(1),
            nominalSizes: z.array(z.number().int().min(1)).min(1),
            portionModes: z.strictObject({
              full: portionMode,
              reduced: portionMode,
            }),
          });
        })().describe(
          "assertEditorConfig checks positive safe integers for preferredSize and nominalSizes, distinct nonblank full and reduced mode names, and finite positive factors with full.factor greater than reduced.factor.",
        ),
        effect: {
          appliesTo: "Sized subscription editor proposals and starter portion calculations use the deployed preferred size, nominal sizes, and portion-mode factors for new edit sessions.",
          frozenOn: ["Existing subscriptions keep their saved package lines and terms until a new edit is accepted."],
          impact: 'customer-promise',
        },
      },
    },
    'quote.acquisition.graduationCadenceDays': {
      value: config.quote?.acquisition?.graduationCadenceDays,
      location: { file: 'owned/quote.config.ts', symbol: 'quoteConfigurations' },
      descriptor: {
        domain: 'pricing',
        goal: "Set the recurring delivery cadence in days after the introductory acquisition phase (graduation cadence, post-intro cycle, starter-pack cadence).",
        schema: z.number().int().min(1).max(3660).describe(
          "assertQuoteConfiguration requires graduationCadenceDays to be an integer cadence admitted by subscriptionOffers.classic.days (1 through 3660).",
        ),
        effect: {
          appliesTo: "New introductory acquisition quotes use the deployed graduation cadence to schedule the post-introductory recurring cycle.",
          frozenOn: ["Saved acquisition quotes and activated subscriptions retain the graduation cadence captured at checkout."],
          impact: 'customer-promise',
        },
      },
    },
    'pricing.minimumProductPayableMinor': {
      value: config.quote?.acquisition?.minimumProductPayableMinor,
      location: { file: 'owned/quote.config.ts', symbol: 'quoteConfigurations' },
      descriptor: {
        domain: 'pricing',
        goal: "Set the minimum payable product amount in currency minor units after discounts (minimum product price, payable floor, discount floor).",
        schema: z.number().int().min(1).max(2147483647).describe(
          "assertQuoteConfiguration checks a positive whole amount in currency minor units (1 through 2147483647).",
        ),
        effect: {
          appliesTo: "Starter acquisition quote installation seeds the minimum payable product floor from this value. The platform quote path reads COMMERCE_MIN_PRODUCT_PAYABLE_MINOR (defaulting to one major unit when unset), while SQL pricing functions read the database mirror row commerce_settings.min_product_payable_minor; keep the deployed value, environment variable, and database mirror aligned.",
          frozenOn: ["Saved quotes, orders, and recorded invoice amounts keep the payable amounts already computed."],
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
