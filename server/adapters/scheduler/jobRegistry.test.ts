import { describe, expect, it } from "vitest";

import {
  jobIdFromPath,
  jobRegistryFromConfig,
  loadJobRegistry,
} from "./jobRegistry.js";

describe("jobRegistry", () => {
  it("derives jobId from a cron path (last segment)", () => {
    expect(jobIdFromPath("/api/cron/dhl-tracking")).toBe("dhl-tracking");
    expect(jobIdFromPath("/api/cron/outbox-dispatch/")).toBe("outbox-dispatch");
  });

  it("throws on an empty/rootless path", () => {
    expect(() => jobIdFromPath("/")).toThrow(/cannot derive jobId/);
  });

  it("builds a registry from a parsed config preserving schedule + path", () => {
    const registry = jobRegistryFromConfig({
      crons: [
        { path: "/api/cron/cleanup", schedule: "0 3 * * *" },
        { path: "/api/cron/outbox-dispatch", schedule: "* * * * *" },
      ],
    });
    expect(registry).toEqual([
      { jobId: "cleanup", schedule: "0 3 * * *", path: "/api/cron/cleanup" },
      { jobId: "outbox-dispatch", schedule: "* * * * *", path: "/api/cron/outbox-dispatch" },
    ]);
  });

  it("returns an empty registry when crons is absent", () => {
    expect(jobRegistryFromConfig({})).toEqual([]);
  });

  it("loads the committed single source and derives unique job ids", () => {
    const registry = loadJobRegistry();
    expect(registry.length).toBeGreaterThan(0);
    const ids = registry.map((job) => job.jobId);
    expect(new Set(ids).size).toBe(ids.length); // no duplicate job ids
    // every job has a non-empty crontab expression
    expect(registry.every((job) => job.schedule.trim().length > 0)).toBe(true);
  });
});
