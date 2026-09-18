import { describe, expect, it } from "vitest";
import * as app from "./cycleHardening.js";
import * as core from "@openlup/core/subscription";

describe("cycle hardening app shim", () => {
  it("re-exports package-owned retry helpers", () => {
    expect(app.maxRetryAttempts).toBe(core.maxRetryAttempts);
    expect(app.nextRetryAttemptAt).toBe(core.nextRetryAttemptAt);
    expect(app.shouldScheduleRetry).toBe(core.shouldScheduleRetry);
  });
});
