import type { MarketingHistoricalConsentCommand, MarketingHistoricalConsentState, MarketingHistoricalConsentResult } from "./contracts/analytics.js";
export type { MarketingHistoricalConsentCommand, MarketingHistoricalConsentState, MarketingHistoricalConsentResult } from "./contracts/analytics.js";
import { z } from "./validation.js";

const historicalTimestamp = z.string().max(80).datetime({ offset: true });
const HISTORICAL_MIN_AGE_MS = 5 * 60 * 1000;

/** Transport chronology after authorization; never changes the local consent grant. */
export function selectMarketingHistoricalConsentTime(input: {
  command: MarketingHistoricalConsentCommand; state: MarketingHistoricalConsentState; now: Date;
}): MarketingHistoricalConsentResult {
  const { command, state, now } = input;
  if (!Number.isFinite(now.getTime())) return { kind: "hold", reason: "consent_time_invalid" };
  let selected = command.consentedAt;
  if (state.consent === "SUBSCRIBED") {
    const native = historicalTimestamp.safeParse(state.nativeConsentAt);
    if (!native.success || !Number.isFinite(Date.parse(native.data)) || Date.parse(native.data) >= now.getTime()) {
      return { kind: "hold", reason: "provider_state_unknown" };
    }
    const overriding = state.suppressions.some(item => item.reason === "UNSUBSCRIBE"
      && (item.listId === null || item.listId === command.listId));
    if (!overriding) selected = native.data;
    else if (Date.parse(command.consentedAt ?? "") > Date.parse(native.data)) {
      return { kind: "hold", reason: "provider_state_unknown" };
    }
  }
  const parsed = historicalTimestamp.safeParse(selected);
  if (!parsed.success || !Number.isFinite(Date.parse(parsed.data)) || Date.parse(parsed.data) >= now.getTime()) {
    return { kind: "hold", reason: "consent_time_invalid" };
  }
  // Parsing truncates fractional milliseconds; round only the age boundary up.
  const discarded = /\.\d{3}(\d+)(?:Z|[+-]\d{2}:\d{2})$/.exec(parsed.data)?.[1];
  const matureAt = Date.parse(parsed.data) + (discarded && /[1-9]/.test(discarded) ? 1 : 0) + HISTORICAL_MIN_AGE_MS;
  return now.getTime() < matureAt ? { kind: "defer", retryAt: new Date(matureAt).toISOString() }
    : { kind: "ready", providerConsentedAt: parsed.data };
}
