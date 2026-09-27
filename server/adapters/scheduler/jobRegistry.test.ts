import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
    expect(loadJobRegistry()).toEqual([]);
    const directory = mkdtempSync(join(tmpdir(), "openlup-job-registry-"));
    const configPath = join(directory, "runtime.json");
    const crons = [{ path: "/api/cron/fixture", schedule: "0 3 * * *" }];
    writeFileSync(configPath, JSON.stringify({ crons }));
    let registry;
    try { registry = loadJobRegistry(configPath); } finally { rmSync(directory, { recursive: true }); }
    expect(registry).toEqual([{ jobId: "fixture", ...crons[0] }]);
    const ids = registry.map((job) => job.jobId);
    expect(new Set(ids).size).toBe(ids.length); // no duplicate job ids
    // every job has a non-empty crontab expression
    expect(registry.every((job) => job.schedule.trim().length > 0)).toBe(true);
  });
});
