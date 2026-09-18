import { describe, expect, it } from "vitest";

import {
  FIRST_PROVIDER_READBACK_DELAY_MS,
  MAX_PROVIDER_READBACKS,
  PROVIDER_READBACK_INTERVAL_MS,
  shouldReadBackProvider,
} from "./paymentVerifyEscalation";

describe("shouldReadBackProvider", () => {
  it("holds off before the first delay elapses, so an unconfirmed BLIK is not read for nothing", () => {
    expect(
      shouldReadBackProvider({
        elapsedMs: FIRST_PROVIDER_READBACK_DELAY_MS - 1,
        readbackCount: 0,
        lastReadbackAtMs: null,
      }),
    ).toBe(false);
  });

  it("reads back once the first delay is reached", () => {
    expect(
      shouldReadBackProvider({
        elapsedMs: FIRST_PROVIDER_READBACK_DELAY_MS,
        readbackCount: 0,
        lastReadbackAtMs: null,
      }),
    ).toBe(true);
  });

  it("waits the full interval between readbacks", () => {
    const lastReadbackAtMs = FIRST_PROVIDER_READBACK_DELAY_MS;
    expect(
      shouldReadBackProvider({
        elapsedMs: lastReadbackAtMs + PROVIDER_READBACK_INTERVAL_MS - 1,
        readbackCount: 1,
        lastReadbackAtMs,
      }),
    ).toBe(false);
    expect(
      shouldReadBackProvider({
        elapsedMs: lastReadbackAtMs + PROVIDER_READBACK_INTERVAL_MS,
        readbackCount: 1,
        lastReadbackAtMs,
      }),
    ).toBe(true);
  });

  it("stops at the cap however long the buyer leaves the tab open", () => {
    // The cap, not elapsed time, is what bounds provider API cost — an
    // abandoned tab used to poll without end, so an interval-only policy would
    // have escalated without end too. The page now stops at PAYMENT_WAIT_CAP_MS,
    // but this count bound is the one that binds provider API cost.
    expect(
      shouldReadBackProvider({
        elapsedMs: 6 * 60 * 60 * 1000,
        readbackCount: MAX_PROVIDER_READBACKS,
        lastReadbackAtMs: 0,
      }),
    ).toBe(false);
  });

  it("still allows the final readback one below the cap", () => {
    expect(
      shouldReadBackProvider({
        elapsedMs: 10 * PROVIDER_READBACK_INTERVAL_MS,
        readbackCount: MAX_PROVIDER_READBACKS - 1,
        lastReadbackAtMs: 0,
      }),
    ).toBe(true);
  });

  it("bounds a whole wait to the cap when driven tick by tick", () => {
    // Guards the composition rather than each rule alone: replaying the real
    // 2.5s poll cadence must never exceed the cap, whatever the constants become.
    let readbackCount = 0;
    let lastReadbackAtMs: number | null = null;
    for (let elapsedMs = 0; elapsedMs <= 30 * 60_000; elapsedMs += 2_500) {
      if (shouldReadBackProvider({ elapsedMs, readbackCount, lastReadbackAtMs })) {
        readbackCount += 1;
        lastReadbackAtMs = elapsedMs;
      }
    }
    expect(readbackCount).toBe(MAX_PROVIDER_READBACKS);
  });
});
