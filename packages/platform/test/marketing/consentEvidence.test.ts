import { expect, it } from "vitest";
import { selectMarketingHistoricalConsentTime, type MarketingHistoricalConsentState } from "../../src/marketing/index.js";
const now = new Date(Date.UTC(2000, 0, 11, 12));
const iso = (delta: number) => new Date(now.getTime() + delta).toISOString();
const minute = 60_000;
const native = iso(-10 * 24 * 60 * minute).replace(".000Z", ".360123+00:00");
const clean: MarketingHistoricalConsentState = { consent: "NEVER_SUBSCRIBED", suppressions: [] };
const subscribed: MarketingHistoricalConsentState = { ...clean, consent: "SUBSCRIBED", nativeConsentAt: native };
const command = (consentedAt = iso(-minute)) => ({ consentedAt, listId: "list:one" });
const select = (state = subscribed, at = iso(-minute), clock = now) =>
  selectMarketingHistoricalConsentTime({ command: command(at), state, now: clock });
it("preserves the exact native channel time without rewriting the local grant", () => {
  const local = command();
  expect(selectMarketingHistoricalConsentTime({ command: local, state: subscribed, now })).toEqual({ kind: "ready", providerConsentedAt: native });
  expect(local.consentedAt).toBe(iso(-minute));
});
it.each([null, undefined, "bad", iso(-minute).replace("01-11", "02-31"),
  iso(-minute).replace("Z", "+99:99"), iso(0).replace(".000Z", ".000001Z")])("holds invalid native time %s", nativeConsentAt => {
  expect(select({ ...subscribed, nativeConsentAt })).toEqual({ kind: "hold", reason: "provider_state_unknown" });
});
it("defers a young new grant without mutating it", () => {
  const local = command();
  expect(selectMarketingHistoricalConsentTime({ command: local, state: clean, now })).toEqual({ kind: "defer", retryAt: iso(4 * minute) });
  expect(local.consentedAt).toBe(iso(-minute));
});
it("does not mature fractional milliseconds early", () => {
  const state = { ...subscribed, nativeConsentAt: iso(-5 * minute).replace(".000Z", ".000001Z") };
  expect(select(state)).toEqual({ kind: "defer", retryAt: iso(1) });
  expect(select(state, undefined, new Date(now.getTime() + 1))).toEqual({ kind: "ready", providerConsentedAt: state.nativeConsentAt });
});
it("does not substitute old global consent over a relevant unsubscribe", () => {
  const state: MarketingHistoricalConsentState = { ...subscribed, suppressions: [{ reason: "UNSUBSCRIBE", listId: "list:one" }] };
  expect(select(state, iso(-24 * 60 * minute))).toEqual({ kind: "hold", reason: "provider_state_unknown" });
  expect(select({ ...clean, consent: "UNSUBSCRIBED", suppressions: [{ reason: "UNSUBSCRIBE", listId: null }] }, iso(-24 * 60 * minute)))
    .toEqual({ kind: "ready", providerConsentedAt: iso(-24 * 60 * minute) });
});
