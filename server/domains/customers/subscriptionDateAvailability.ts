import type {
  CustomerSubscriptionBlockReason,
  CustomerSubscriptionPreviewResponse,
} from "../../../src/domains/customers/subscriptionFacadeContracts.js";

const DAY_MS = 24 * 60 * 60 * 1000;
const RESCHEDULE_MIN_DAYS = 3;
const RESCHEDULE_MAX_DAYS = 60;

export function dateAvailability(blockedReason: CustomerSubscriptionBlockReason): NonNullable<
  CustomerSubscriptionPreviewResponse["preview"]["dateAvailability"]
> {
  const now = new Date();
  const earliest = new Date(now.getTime() + RESCHEDULE_MIN_DAYS * DAY_MS);
  const latest = new Date(now.getTime() + RESCHEDULE_MAX_DAYS * DAY_MS);
  const availableDates: string[] = [];
  if (!blockedReason) {
    for (let offset = RESCHEDULE_MIN_DAYS; offset <= RESCHEDULE_MAX_DAYS; offset += 1) {
      const date = new Date(now);
      date.setUTCDate(date.getUTCDate() + offset);
      date.setUTCHours(12, 0, 0, 0);
      if (date < earliest) continue;
      if (date > latest) break;
      availableDates.push(date.toISOString());
    }
  }
  return {
    earliestAllowedAt: earliest.toISOString(),
    latestAllowedAt: latest.toISOString(),
    availableDates,
    blockedReason,
  };
}
