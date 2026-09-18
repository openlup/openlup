import { afterEach, describe, expect, it, vi } from "vitest";

import { createNpmReleaseChecks } from "../scripts/release-npm-checks.ts";

type CommandResult = {
  status: number | null;
  stdout: string;
  stderr: string;
  error?: Error & { code?: string };
  signal?: NodeJS.Signals | null;
};

const gates = {
  audit: { maximumVulnerabilities: { critical: 0, high: 0, moderate: 0 } },
  pack: {
    maxPackedBytes: 1,
    maxUnpackedBytes: 1,
    maxFiles: 1,
    requiredFiles: [],
  },
};

function auditResult(stdout: string, status = 0): CommandResult {
  return { status, stdout, stderr: "" };
}

// What `spawnSync` returns when it kills a child on `timeout`: no usable
// stdout, an ETIMEDOUT error, and the signal it used.
function timedOutResult(): CommandResult {
  return {
    status: null,
    stdout: "",
    stderr: "",
    error: Object.assign(new Error("spawnSync npm ETIMEDOUT"), {
      code: "ETIMEDOUT",
    }),
    signal: "SIGKILL",
  };
}

function reportWithoutTotals(): string {
  return JSON.stringify({
    auditReportVersion: 2,
    vulnerabilities: {},
    filler: "x".repeat(600),
  });
}

function reportWithTotals(
  vulnerabilities: Record<string, number> = {
    critical: 0,
    high: 0,
    moderate: 0,
  },
): string {
  return JSON.stringify({ auditReportVersion: 2, metadata: { vulnerabilities } });
}

function createAudit(responses: CommandResult[]) {
  const calls: string[][] = [];
  const delays: number[] = [];
  const timeouts: Array<number | undefined> = [];
  const checks = createNpmReleaseChecks({
    packageRoot: "/package-root",
    manifest: { name: "@scope/package", version: "0.0.0", exports: {} },
    gates,
    lock: { packages: {} },
    run: (_packageRoot, args, timeoutMs) => {
      calls.push(args);
      timeouts.push(timeoutMs);
      const response = responses[calls.length - 1];
      if (!response) throw new Error("the check asked for one attempt too many");
      return response;
    },
    sleep: (milliseconds) => {
      delays.push(milliseconds);
    },
  });
  return { audit: checks.audit, calls, delays, timeouts };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("release audit check", () => {
  it("re-asks after a report that parses without vulnerability totals", () => {
    const logged = vi.spyOn(console, "log").mockImplementation(() => {});
    const { audit, calls, delays } = createAudit([
      auditResult(reportWithoutTotals()),
      auditResult(reportWithTotals()),
    ]);

    expect(() => audit()).not.toThrow();

    expect(calls).toHaveLength(2);
    expect(delays).toEqual([2000]);
    expect(logged).toHaveBeenCalledWith(
      "npm audit returned no vulnerability totals (attempt 1 of 3); retrying",
    );
    expect(logged).toHaveBeenCalledWith("production dependency audit ok");
  });

  it("refuses after three empty reports and shows the head of the last one", () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    const lastReport = reportWithoutTotals();
    const { audit, calls, delays } = createAudit([
      auditResult(reportWithoutTotals()),
      auditResult(reportWithoutTotals()),
      auditResult(lastReport),
    ]);

    let message = "";
    try {
      audit();
    } catch (error) {
      message = (error as Error).message;
    }

    expect(message).toMatch(/missing vulnerability totals after 3 attempts/);
    expect(message).toContain(lastReport.slice(0, 400));
    expect(message).not.toContain(lastReport.slice(0, 401));
    expect(calls).toHaveLength(3);
    expect(delays).toEqual([2000, 4000]);
  });

  it("evaluates a report with totals on the first attempt, without retrying", () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    const { audit, calls, delays } = createAudit([
      auditResult(reportWithTotals({ critical: 2, high: 0, moderate: 0 }), 1),
    ]);

    expect(() => audit()).toThrow(/production audit budget exceeded/);
    expect(calls).toHaveLength(1);
    expect(delays).toEqual([]);
  });

  it("refuses an unparseable report without retrying", () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    const { audit, calls, delays } = createAudit([
      auditResult("not json at all"),
    ]);

    expect(() => audit()).toThrow(/npm audit emitted invalid JSON/);
    expect(calls).toHaveLength(1);
    expect(delays).toEqual([]);
  });

  it("passes the same audit arguments on every attempt", () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    const { audit, calls } = createAudit([
      auditResult(reportWithoutTotals()),
      auditResult(reportWithTotals()),
    ]);

    audit();

    expect(calls[0]).toEqual([
      "audit",
      "--omit=dev",
      "--package-lock-only",
      "--json",
      "--workspaces=false",
    ]);
    expect(calls[1]).toEqual(calls[0]);
  });

  it("bounds every attempt, so a hung call cannot outlive the job", () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    const { audit, timeouts } = createAudit([auditResult(reportWithTotals())]);

    audit();

    expect(timeouts).toEqual([120_000]);
  });

  it("re-asks after an attempt that never answered", () => {
    const logged = vi.spyOn(console, "log").mockImplementation(() => {});
    const { audit, calls, delays } = createAudit([
      timedOutResult(),
      auditResult(reportWithTotals()),
    ]);

    expect(() => audit()).not.toThrow();

    expect(calls).toHaveLength(2);
    expect(delays).toEqual([2000]);
    expect(logged).toHaveBeenCalledWith(
      "npm audit did not answer within 120 s (attempt 1 of 3); retrying",
    );
    expect(logged).toHaveBeenCalledWith("production dependency audit ok");
  });

  it("refuses after three attempts that never answered, naming the timeout", () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    const { audit, calls, delays } = createAudit([
      timedOutResult(),
      timedOutResult(),
      timedOutResult(),
    ]);

    let message = "";
    try {
      audit();
    } catch (error) {
      message = (error as Error).message;
    }

    expect(message).toBe(
      "npm audit did not answer within 120 s on the last of 3 attempts",
    );
    expect(calls).toHaveLength(3);
    expect(delays).toEqual([2000, 4000]);
  });

  it("evaluates the budget on the answer after a timeout, without a third attempt", () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    const { audit, calls, delays } = createAudit([
      timedOutResult(),
      auditResult(reportWithTotals({ critical: 1, high: 0, moderate: 0 }), 1),
    ]);

    expect(() => audit()).toThrow(/production audit budget exceeded/);
    expect(calls).toHaveLength(2);
    expect(delays).toEqual([2000]);
  });
});
