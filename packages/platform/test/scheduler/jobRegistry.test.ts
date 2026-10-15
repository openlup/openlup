import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import {
  jobIdFromPath,
  jobRegistryFromConfig,
  loadJobRegistry,
} from "../../src/scheduler/jobRegistry.js";

describe("jobRegistry", () => {
  it("derives jobId from a cron path (last segment)", () => {
    expect(jobIdFromPath("/api/cron/nightly-report")).toBe("nightly-report");
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

  it("loads the jobs of the configuration file the caller names", () => {
    const directory = mkdtempSync(join(tmpdir(), "platform-job-registry-"));
    try {
      const file = join(directory, "platform-runtime.json");
      writeFileSync(file, JSON.stringify({ crons: [{ path: "/api/cron/nightly-report", schedule: "0 2 * * *" }] }));
      expect(loadJobRegistry(file)).toEqual([
        { jobId: "nightly-report", schedule: "0 2 * * *", path: "/api/cron/nightly-report" },
      ]);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
