import { describe, expect, it } from "vitest";
import type { EmailHealthMetrics } from "./emailHealthMetricsPort.js";
import {
  evaluateEmailHealth,
  readEmailHealthThresholds,
  type EmailHealthThresholds,
} from "./emailHealthAssessment.js";

const THRESHOLDS: EmailHealthThresholds = {
  windowMinutes: 60,
  stuckMinutes: 30,
  minAttemptsForRatio: 5,
  maxFailureRatio: 0.5,
  maxStuck: 0,
  maxPermanentFailures: 0,
};

const HEALTHY: EmailHealthMetrics = {
  attempted: 10,
  sent: 10,
  failed: 0,
  delayed: 0,
  permanentFailures: 0,
  stuckProcessing: 0,
  stuckScheduled: 0,
};

describe("readEmailHealthThresholds", () => {
  it("defaults maxPermanentFailures to 0 (a single lost email breaches)", () => {
    expect(readEmailHealthThresholds({}).maxPermanentFailures).toBe(0);
  });

  it("reads a non-negative override and rejects garbage", () => {
    expect(
      readEmailHealthThresholds({ EMAIL_HEALTH_MAX_PERMANENT_FAILURES: "3" }).maxPermanentFailures,
    ).toBe(3);
    expect(
      readEmailHealthThresholds({ EMAIL_HEALTH_MAX_PERMANENT_FAILURES: "-1" }).maxPermanentFailures,
    ).toBe(0);
    expect(
      readEmailHealthThresholds({ EMAIL_HEALTH_MAX_PERMANENT_FAILURES: "nope" }).maxPermanentFailures,
    ).toBe(0);
  });

  it("keeps the pre-existing threshold defaults", () => {
    expect(readEmailHealthThresholds({})).toEqual({
      windowMinutes: 60,
      stuckMinutes: 30,
      minAttemptsForRatio: 5,
      maxFailureRatio: 0.5,
      maxStuck: 0,
      maxPermanentFailures: 0,
    });
  });
});

describe("evaluateEmailHealth — permanent_delivery_failure", () => {
  it("breaches on a single terminally-failed delivery even below the ratio gate", () => {
    // Incident 2026-07-24: 1 failed send out of 1 attempt — failure_ratio
    // stays silent (attempted < minAttemptsForRatio) but the customer email
    // is lost. The absolute breach must fire.
    const result = evaluateEmailHealth(
      { ...HEALTHY, attempted: 1, sent: 0, failed: 1, permanentFailures: 1 },
      THRESHOLDS,
    );
    expect(result.healthy).toBe(false);
    expect(result.breaches.map((b) => b.code)).toContain("permanent_delivery_failure");
  });

  it("stays healthy when the override threshold absorbs the count", () => {
    const result = evaluateEmailHealth(
      { ...HEALTHY, attempted: 2, sent: 1, failed: 1, permanentFailures: 1 },
      { ...THRESHOLDS, maxPermanentFailures: 1 },
    );
    expect(result.breaches.map((b) => b.code)).not.toContain("permanent_delivery_failure");
  });

  it("does not fire on bounce-only failure counts (permanentFailures stays 0)", () => {
    // Bounced/complained rows raise `failed` (ratio input) but not
    // `permanentFailures`; the absolute breach must not page on typos.
    const result = evaluateEmailHealth(
      { ...HEALTHY, attempted: 3, sent: 2, failed: 1, permanentFailures: 0 },
      THRESHOLDS,
    );
    expect(result.breaches.map((b) => b.code)).not.toContain("permanent_delivery_failure");
    expect(result.healthy).toBe(true);
  });

  it("composes with the existing breaches unchanged", () => {
    const result = evaluateEmailHealth(
      { ...HEALTHY, attempted: 10, sent: 3, failed: 7, permanentFailures: 2, stuckProcessing: 1 },
      THRESHOLDS,
    );
    expect(result.breaches.map((b) => b.code)).toEqual([
      "failure_ratio",
      "permanent_delivery_failure",
      "stuck_processing",
    ]);
  });
});
