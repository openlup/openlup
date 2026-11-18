/** @experimental Informational catalogue entries owned by subscriptions. */
export const subscriptionsSettingBoundaries: readonly (readonly [key: string, kind: "cap" | "invariant", goal: string, reason: string])[] = [
  ["retrySchedule", "cap", "Use one retry schedule for host and provider-recorded payment failures.", "Provider-recorded failures still use the fixed 24, 72 and 168 hour schedule."],
  ["calendarCadence", "cap", "Renew subscriptions on a fixed calendar day.", "Native cadence is expressed in days."],
  ["introductoryPhases", "cap", "Schedule introductory discounts by renewal cycle.", "Native terms support one introductory phase before the retained terms take over."],
  ["addressBasedRenewalShipping", "cap", "Reprice renewal shipping from the current address.", "Retained native terms carry one shipping threshold profile."],
  ["renewalPriceChanges", "cap", "Change a renewal price without changing the subscription basket.", "Native renewal prices are locked until an edit changes the terms."],
  ["prepaidCycles", "cap", "Prepay several subscription deliveries.", "Native commands refuse multi-cycle prepaid subscriptions."],
  ["lifecycleNoticeRetryBudget", "cap", "Set the retry budget for subscription lifecycle notices.", "Native notice dispatch uses a limit of six attempts."],
  ["customPauseDurations", "cap", "Offer custom subscription pause durations.", "Native lifecycle commands support two weeks, one month and indefinite."],
  ["stockWaitHoldLifetime", "cap", "Set the stock hold lifetime when a renewal leaves stock wait.", "Native recovery holds stock for 900 seconds."],
  ["rescheduleTimeZone", "cap", "Calculate a subscription reschedule date in the market time zone.", "The native command compares dates using UTC days."],
  ["winbackEpisodeDeduplication", "cap", "Send winback again for a new cancellation episode.", "The native winback receipt deduplicates by subscription."],
  ["sharedDeliveryControls", "cap", "Use the same delivery controls for managed and native notices.", "Managed and native delivery paths use separate controls."],
  ["subscriberReviewWindows", "cap", "Set windows for subscriber review requests.", "Review branches exist in SQL and need composition before exposing a setting."],
  ["deliveryAlignmentEvidence", "invariant", "Require delivery evidence and move alignment only later.", "A late delivery extends the cycle without stacking deliveries. A replacement counts only after arrival."],
  ["unknownPaymentReconciliation", "invariant", "Reconcile unknown payment outcomes before retrying and stop on hard declines.", "Retrying a charge with an unknown outcome risks charging twice."],
];
