import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  SUBSCRIPTION_ENGINE_EVENT_TYPES,
  SUBSCRIPTION_CYCLE_STATUSES,
  SUBSCRIPTION_RECORD_STATUSES,
  SUBSCRIPTION_STATUSES,
} from "./types.js";
import { SubscriptionLifecycleNotConfiguredError } from "./ports.js";

describe("subscription domain primitives", () => {
  it("engine subscription statuses stay scoped to runtime-managed lifecycles", () => {
    expect(SUBSCRIPTION_STATUSES).toEqual(["active", "paused", "cancelled", "completed"]);
  });

  it("persisted subscription status constants match the latest DB check constraints", () => {
    expect(SUBSCRIPTION_RECORD_STATUSES).toEqual(latestStatusCheckValues("subscriptions_status_check"));
    expect(SUBSCRIPTION_CYCLE_STATUSES).toEqual(latestStatusCheckValues("subscription_cycles_status_check"));
  });

  it("engine event types include the local lifecycle transitions openlup owns", () => {
    expect(SUBSCRIPTION_ENGINE_EVENT_TYPES).toContain("subscription.cycle_planned");
    expect(SUBSCRIPTION_ENGINE_EVENT_TYPES).toContain("subscription.payment_requested");
    expect(SUBSCRIPTION_ENGINE_EVENT_TYPES).toContain("subscription.payment_failed");
    expect(SUBSCRIPTION_ENGINE_EVENT_TYPES).toContain("subscription.retry_scheduled");
    expect(SUBSCRIPTION_ENGINE_EVENT_TYPES).toContain("subscription.cycle_paid");
    expect(SUBSCRIPTION_ENGINE_EVENT_TYPES).toContain("subscription.template_updated");
    expect(SUBSCRIPTION_ENGINE_EVENT_TYPES).toContain("subscription.cancelled");
  });

  it("SubscriptionLifecycleNotConfiguredError names the local engine reason", () => {
    const error = new SubscriptionLifecycleNotConfiguredError("feature_flag_disabled");
    expect(error.name).toBe("SubscriptionLifecycleNotConfiguredError");
    expect(error.message).toContain("feature_flag_disabled");
  });
});

function latestStatusCheckValues(constraintName: string): string[] {
  const migrationsDir = join(process.cwd(), "supabase/migrations");
  const files = readdirSync(migrationsDir).filter((file) => file.endsWith(".sql")).sort();
  let latest: { file: string; statuses: string[] } | null = null;

  for (const file of files) {
    const source = readFileSync(join(migrationsDir, file), "utf8");
    const constraintPattern = new RegExp(
      `(?:ADD\\s+)?CONSTRAINT\\s+${constraintName}\\s+CHECK\\s*\\(\\s*\\(?status\\s+(?:IN\\s*\\(([^)]*)\\)|=\\s*ANY\\s*\\(ARRAY\\[([^\\]]*)\\])`,
      "i",
    );
    const match = source.match(constraintPattern);
    if (!match) continue;
    const statusList = match[1] ?? match[2];
    if (!statusList) continue;
    latest = {
      file,
      statuses: Array.from(statusList.matchAll(/'([^']+)'/g)).map((statusMatch) => {
        const status = statusMatch[1];
        if (!status) throw new Error(`Malformed status literal in ${file} for ${constraintName}`);
        return status;
      }),
    };
  }

  if (!latest || latest.statuses.length === 0) {
    throw new Error(`Missing status check values for ${constraintName}`);
  }
  return latest.statuses;
}
