import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  OUTBOX_DISPATCH_CRON_MAX_DURATION_SECONDS,
  OUTBOX_DISPATCH_MIN_VISIBILITY_SECONDS,
  readOutboxDispatchConfig,
} from "./outboxDispatchContracts.js";

describe("readOutboxDispatchConfig", () => {
  let warnSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
  });

  afterEach(() => {
    warnSpy.mockRestore();
  });

  it("returns defaults when the env is empty", () => {
    expect(readOutboxDispatchConfig({})).toEqual({
      batchSize: 25,
      maxAttempts: 8,
      visibilitySeconds: 300,
      backoffBaseSeconds: 60,
      backoffCapSeconds: 3600,
      snoozeSeconds: 300,
      maxSnoozes: 48,
      softBudgetMs: 40_000,
    });
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it("treats blank values as unset without warning", () => {
    const config = readOutboxDispatchConfig({
      COMMERCE_OUTBOX_DISPATCH_BATCH_SIZE: "  ",
    });
    expect(config.batchSize).toBe(25);
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it("clamps visibility below the 5x maxDuration floor up to 300 and warns", () => {
    const config = readOutboxDispatchConfig({
      COMMERCE_OUTBOX_DISPATCH_VISIBILITY_SECONDS: "60",
    });
    expect(OUTBOX_DISPATCH_MIN_VISIBILITY_SECONDS).toBe(300);
    expect(config.visibilitySeconds).toBe(300);
    expect(warnSpy).toHaveBeenCalledWith(
      "[outbox-dispatch] COMMERCE_OUTBOX_DISPATCH_VISIBILITY_SECONDS=60 clamped to 300",
    );
  });

  it("clamps batch size above the max down to 100 and warns", () => {
    const config = readOutboxDispatchConfig({
      COMMERCE_OUTBOX_DISPATCH_BATCH_SIZE: "1000",
    });
    expect(config.batchSize).toBe(100);
    expect(warnSpy).toHaveBeenCalledWith(
      "[outbox-dispatch] COMMERCE_OUTBOX_DISPATCH_BATCH_SIZE=1000 clamped to 100",
    );
  });

  it("clamps softBudgetMs above the cron-kill ceiling down to 45_000 and warns", () => {
    const config = readOutboxDispatchConfig({
      COMMERCE_OUTBOX_DISPATCH_SOFT_BUDGET_MS: "55000",
    });
    // The ceiling keeps a >= 15s tail under the cron's hard kill.
    expect(config.softBudgetMs).toBe(OUTBOX_DISPATCH_CRON_MAX_DURATION_SECONDS * 1000 - 15_000);
    expect(config.softBudgetMs).toBe(45_000);
    expect(warnSpy).toHaveBeenCalledWith(
      "[outbox-dispatch] COMMERCE_OUTBOX_DISPATCH_SOFT_BUDGET_MS=55000 clamped to 45000",
    );
  });

  it("falls back to the default on a non-numeric value and warns", () => {
    const config = readOutboxDispatchConfig({
      COMMERCE_OUTBOX_DISPATCH_MAX_ATTEMPTS: "abc",
    });
    expect(config.maxAttempts).toBe(8);
    expect(warnSpy).toHaveBeenCalledWith(
      "[outbox-dispatch] invalid COMMERCE_OUTBOX_DISPATCH_MAX_ATTEMPTS=abc; using default 8",
    );
  });

  it("raises a backoff cap below the base up to the base and warns", () => {
    const config = readOutboxDispatchConfig({
      COMMERCE_OUTBOX_DISPATCH_BACKOFF_BASE_SECONDS: "600",
      COMMERCE_OUTBOX_DISPATCH_BACKOFF_CAP_SECONDS: "300",
    });
    expect(config.backoffBaseSeconds).toBe(600);
    expect(config.backoffCapSeconds).toBe(600);
    expect(warnSpy).toHaveBeenCalledWith(
      "[outbox-dispatch] backoff cap 300s below base 600s; raising cap to base",
    );
  });

  it("reads every tuning variable from its COMMERCE_OUTBOX_DISPATCH_* env name", () => {
    expect(
      readOutboxDispatchConfig({
        COMMERCE_OUTBOX_DISPATCH_BATCH_SIZE: "10",
        COMMERCE_OUTBOX_DISPATCH_MAX_ATTEMPTS: "5",
        COMMERCE_OUTBOX_DISPATCH_VISIBILITY_SECONDS: "600",
        COMMERCE_OUTBOX_DISPATCH_BACKOFF_BASE_SECONDS: "30",
        COMMERCE_OUTBOX_DISPATCH_BACKOFF_CAP_SECONDS: "7200",
        COMMERCE_OUTBOX_DISPATCH_SNOOZE_SECONDS: "120",
        COMMERCE_OUTBOX_DISPATCH_MAX_SNOOZES: "10",
        COMMERCE_OUTBOX_DISPATCH_SOFT_BUDGET_MS: "30000",
      }),
    ).toEqual({
      batchSize: 10,
      maxAttempts: 5,
      visibilitySeconds: 600,
      backoffBaseSeconds: 30,
      backoffCapSeconds: 7200,
      snoozeSeconds: 120,
      maxSnoozes: 10,
      softBudgetMs: 30_000,
    });
    expect(warnSpy).not.toHaveBeenCalled();
  });
});
