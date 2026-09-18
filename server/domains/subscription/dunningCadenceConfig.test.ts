import { describe, expect, it } from "vitest";
import {
  DEFAULT_DUNNING_CADENCE,
  DEFAULT_DUNNING_NOTIFICATION_KINDS,
} from "./dunningCadenceConfig.js";

describe("dunning cadence configuration", () => {
  // The whole point of extracting these numbers was that wiring them changed no
  // schedule. This case is what makes that claim checkable rather than asserted:
  // each value is the literal the cron file it came from used to hold.
  it("carries the shipped schedule verbatim", () => {
    expect(DEFAULT_DUNNING_CADENCE.dispatch).toEqual({
      batchSize: 25,
      leaseSeconds: 300,
      maxAttempts: 6,
      transientBackoffMinutes: 60,
    });
    expect(DEFAULT_DUNNING_CADENCE.recovered).toEqual({ windowDays: 7, batchSize: 50 });
    expect(DEFAULT_DUNNING_CADENCE.atRisk).toEqual({ minDays: 2, maxDays: 5, batchSize: 100 });
    expect(DEFAULT_DUNNING_CADENCE.renewalReminder).toEqual({ minDays: 3, maxDays: 5, batchSize: 100 });
    expect(DEFAULT_DUNNING_CADENCE.pauseReminder).toEqual({ batchSize: 100 });
  });

  it("admits exactly the notice kinds that ship today, so the gate refuses none of them", () => {
    expect(DEFAULT_DUNNING_CADENCE.allowedNotificationKinds).toBe(DEFAULT_DUNNING_NOTIFICATION_KINDS);
    expect([...DEFAULT_DUNNING_NOTIFICATION_KINDS]).toEqual([
      "payment_failed",
      "payment_expired",
      "payment_recovery",
    ]);
  });

  it("freezes the shipped default so no caller can edit the schedule in place", () => {
    expect(Object.isFrozen(DEFAULT_DUNNING_CADENCE)).toBe(true);
    expect(Object.isFrozen(DEFAULT_DUNNING_CADENCE.dispatch)).toBe(true);
    expect(Object.isFrozen(DEFAULT_DUNNING_CADENCE.recovered)).toBe(true);
    expect(Object.isFrozen(DEFAULT_DUNNING_CADENCE.atRisk)).toBe(true);
    expect(Object.isFrozen(DEFAULT_DUNNING_CADENCE.renewalReminder)).toBe(true);
    expect(Object.isFrozen(DEFAULT_DUNNING_CADENCE.pauseReminder)).toBe(true);
    expect(Object.isFrozen(DEFAULT_DUNNING_NOTIFICATION_KINDS)).toBe(true);
  });
});
