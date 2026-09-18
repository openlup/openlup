import { readFileSync, readdirSync } from "node:fs";
import { describe, expect, it } from "vitest";

import { JOB_CATALOG } from "../../src/domains/platform/jobCatalog.js";
import { resolveSweepConfig } from "../../server/_lib/sweeps/sweepConfig.js";

// Anti-drift guardrail: the flag that actually gates whether a cron runs must be
// the SAME flag the watchdog uses to decide the job is "expected to run"
// (jobCatalog.requiresFlag, consumed by observabilityEvaluator). A mismatch means
// either false p1 alerts or — worse — a silently dead billing/sweep job the
// watchdog never flags. This test makes any future divergence fail CI.

const requiresFlagByJob = new Map<string, string>(
  JOB_CATALOG.filter((j) => j.requiresFlag).map((j) => [j.jobName, j.requiresFlag as string]),
);

function readCron(file: string): { jobName?: string; gateFlag?: string } {
  const src = readFileSync(file, "utf8");
  const jobName = src.match(/const JOB_NAME = "([^"]+)"/)?.[1];
  // The job enable-gate is the first `if (env.X !== "true")` early-return.
  const gateFlag = src.match(/if \(env\.([A-Z0-9_]+) !== "true"\)/)?.[1];
  return { jobName, gateFlag };
}

// Sweep crons gate via resolveSweepConfig(env).<field>.enabled, so there is no
// literal `env.X !== "true"` in the cron file — they are validated separately.
const SWEEP_JOB_TO_FIELD: Record<string, "reservation" | "reservationAutoExpiry" | "paymentEvent" | "subscriptionActivation"> = {
  "commerce-reservation-sweep": "reservation",
  "commerce-reservation-auto-expiry": "reservationAutoExpiry",
  "commerce-payment-event-sweep": "paymentEvent",
  "subscription-activation-sweep-runtime": "subscriptionActivation",
};

describe("cron gate flag matches its jobCatalog requiresFlag (anti-drift)", () => {
  // Entrypoints live in api/cron; the job modules that carry JOB_NAME and the
  // enable-gate live in api/_cron (helpers the hosting platform never deploys
  // as functions). Scan both.
  const cronFiles = ["api/cron", "api/_cron"].flatMap((dir) =>
    readdirSync(dir)
      .filter((f) => f.endsWith(".ts") && !f.endsWith(".test.ts"))
      .map((f) => `${dir}/${f}`),
  );

  for (const file of cronFiles) {
    const { jobName, gateFlag } = readCron(file);
    if (!jobName || !gateFlag) continue;
    const requiresFlag = requiresFlagByJob.get(jobName);
    if (!requiresFlag) continue;
    it(`${file} (${jobName}) gates on its requiresFlag`, () => {
      expect(gateFlag).toBe(requiresFlag);
    });
  }

  it("sweep crons resolve enablement from the same flag as their requiresFlag", () => {
    for (const [jobName, field] of Object.entries(SWEEP_JOB_TO_FIELD)) {
      const flag = requiresFlagByJob.get(jobName);
      expect(flag, `${jobName} should declare a requiresFlag`).toBeDefined();
      expect(resolveSweepConfig({ [flag as string]: "true" })[field].enabled).toBe(true);
      expect(resolveSweepConfig({})[field].enabled).toBe(false);
    }
  });

  it("the subscription renewal cron is gated by the dedicated renewal-runtime flag", () => {
    const { jobName, gateFlag } = readCron("api/cron/subscription-renewal.ts");
    expect(jobName).toBe("subscription-renewal-runtime");
    expect(gateFlag).toBe("COMMERCE_SUBSCRIPTION_RENEWAL_RUNTIME_ENABLED");
    expect(requiresFlagByJob.get("subscription-renewal-runtime")).toBe(gateFlag);
  });
});
