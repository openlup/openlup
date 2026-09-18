/**
 * Public/default owner of `#cancel-survey-reasons`: the Example Store's
 * cancellation taxonomy.
 *
 * The subscription self-service contract validates the *shape* of a cancel
 * survey; the concrete set of reasons a customer may pick is a commercial
 * decision that belongs to whoever runs the store. This file is the neutral set
 * a fresh installation starts from, so the cancel flow renders and records a
 * real answer out of the box instead of an empty radio group.
 *
 * The six codes below are the churn reasons that exist in any subscription
 * business, independent of what is in the box: price, fit, frequency, quality,
 * logistics, and an explicit escape hatch. A deployment that needs finer
 * categories supplies its own set next to this one.
 *
 * ⛔ These string values are PERSISTED verbatim into
 * `subscription_retention_outcomes.cancel_reason_code` and aggregated by the
 * retention funnel views. For any deployment, including this one, the set is
 * APPEND-ONLY: renaming or removing a value silently rewrites analytics
 * history, because there is no DB enum to refuse it.
 */
export const CANCEL_SURVEY_REASON_CODES = [
  "too_expensive",
  "not_a_good_fit",
  "too_much_product",
  "too_little_product",
  "delivery_issue",
  "other",
] as const;

export type CancelSurveyReasonCode = (typeof CANCEL_SURVEY_REASON_CODES)[number];
