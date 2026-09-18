import { describe, expect, it } from "vitest";
import { silenceIsOverdue } from "./paymentAttemptSilenceWindow.js";
import type { ClaimedPaymentAttempt } from "./paymentProviderReconciliationContracts.js";

/**
 * The predicate that separates "still running" from "stuck".
 *
 * Every case here is a way to be wrong about money: too eager and a healthy
 * charge gets a human chasing it, too lax and a stalled one stays invisible for
 * a day and a half, which is what happened on 2026-08-12.
 */
describe("silenceIsOverdue", () => {
  const NOW = "2026-08-13T19:00:00.000Z";
  // Only two fields are read. The rail key is irrelevant here because the
  // lookup is stubbed, so the fixture states exactly what the predicate uses
  // rather than pretending to be a whole claimed attempt.
  const at = (localUpdatedAt: string) =>
    ({ localUpdatedAt, provider: "" } as unknown as ClaimedPaymentAttempt);
  const declaring = (minutes: unknown) => ({
    get: () => ({ terminalOutcomeReporting: { silenceBecomesSuspectAfterMinutes: minutes } }),
  } as never);

  it("is overdue once the declared window has fully elapsed", () => {
    expect(silenceIsOverdue(declaring(360), at("2026-08-12T10:00:03.000Z"), NOW)).toBe(true);
  });

  it("is not overdue one minute before the window closes", () => {
    expect(silenceIsOverdue(declaring(60), at("2026-08-13T18:01:00.000Z"), NOW)).toBe(false);
  });

  it("treats the exact boundary as overdue rather than leaving it ambiguous", () => {
    expect(silenceIsOverdue(declaring(60), at("2026-08-13T18:00:00.000Z"), NOW)).toBe(true);
  });

  it("stays quiet when no capability is published for the rail", () => {
    expect(silenceIsOverdue({ get: () => null }, at("2020-01-01T00:00:00.000Z"), NOW)).toBe(false);
  });

  it("stays quiet when the capability omits the window", () => {
    expect(silenceIsOverdue({ get: () => ({}) }, at("2020-01-01T00:00:00.000Z"), NOW)).toBe(false);
  });

  it("stays quiet when there is no lookup at all", () => {
    expect(silenceIsOverdue(undefined, at("2020-01-01T00:00:00.000Z"), NOW)).toBe(false);
  });

  it.each([0, -60, Number.NaN, Number.POSITIVE_INFINITY, "360", null])(
    "refuses to accuse a rail on an unusable window: %s",
    (minutes) => {
      expect(silenceIsOverdue(declaring(minutes), at("2020-01-01T00:00:00.000Z"), NOW)).toBe(false);
    },
  );

  it.each(["", "not-a-date", "2026-13-45T99:99:99Z"])(
    "refuses to accuse a rail on an unreadable timestamp: %s",
    (stamp) => {
      expect(silenceIsOverdue(declaring(60), at(stamp), NOW)).toBe(false);
    },
  );

  it("never reports overdue for an attempt whose clock reads in the future", () => {
    expect(silenceIsOverdue(declaring(60), at("2026-08-14T19:00:00.000Z"), NOW)).toBe(false);
  });
});
