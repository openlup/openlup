import { randomBytes } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  createNpmReleaseChecks,
  packFileClass,
} from "../scripts/release-npm-checks.ts";

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
    code: { maxPackedBytes: 1, maxFiles: 1 },
    docs: { maxPackedBytes: 1, maxFiles: 1 },
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

// A tarball inside every cap of packGates; each test plants one overflow.
const packGates = {
  audit: gates.audit,
  pack: {
    code: { maxPackedBytes: 2048, maxFiles: 2 },
    docs: { maxPackedBytes: 1024, maxFiles: 2 },
    maxPackedBytes: 4096,
    maxUnpackedBytes: 16_384,
    maxFiles: 5,
    requiredFiles: ["AGENTS.md"],
  },
};

function withinBudget(): Record<string, Buffer> {
  return {
    "dist/index.js": Buffer.from("export const kernel = 1;\n"),
    "src/index.ts": Buffer.from("export const kernel = 1;\n"),
    "AGENTS.md": Buffer.from("# Agent guide\n"),
    "package.json": Buffer.from("{}\n"),
  };
}

function runPack(
  files: Record<string, Buffer>,
  options: { size?: number; pack?: Partial<typeof packGates.pack> } = {},
): void {
  const paths = Object.keys(files);
  const checks = createNpmReleaseChecks({
    packageRoot: "/package-root",
    manifest: { name: "@scope/package", version: "0.0.0", exports: {} },
    gates: { ...packGates, pack: { ...packGates.pack, ...options.pack } },
    lock: { packages: {} },
    run: () => ({
      status: 0,
      stderr: "",
      stdout: JSON.stringify([
        {
          size: options.size ?? 1000,
          unpackedSize: paths.reduce((total, path) => total + files[path].length, 0),
          entryCount: paths.length,
          files: paths.map((path) => ({ path })),
        },
      ]),
    }),
    readPackedFile: (path) => files[path],
  });
  checks.pack();
}

describe("release pack check", () => {
  it("classes dist JavaScript, declarations and sources as code and root files as docs", () => {
    expect(packFileClass("dist/subscription/index.js")).toBe("code");
    expect(packFileClass("dist/subscription/index.d.ts")).toBe("code");
    expect(packFileClass("src/subscription/index.ts")).toBe("code");
    expect(packFileClass("CHANGELOG.md")).toBe("docs");
    expect(packFileClass("release-gates.json")).toBe("docs");
    expect(packFileClass("dist/subscription/index.js.map")).toBe("other");
    expect(packFileClass("assets/logo.png")).toBe("other");
  });

  it("accepts a tarball inside every cap and reports each class", () => {
    const logged = vi.spyOn(console, "log").mockImplementation(() => {});

    runPack(withinBudget());

    expect(logged).toHaveBeenCalledWith(
      expect.stringMatching(/; code \d+ packed bytes in 2 files; docs \d+ packed bytes in 2 files\)$/),
    );
  });

  it("refuses code whose packed bytes exceed the code cap", () => {
    const files = { ...withinBudget(), "dist/index.js": randomBytes(3000) };
    expect(() => runPack(files)).toThrow(/^code packed bytes \d+ exceed 2048$/);
  });

  it("refuses one code file more than the code cap", () => {
    const files = { ...withinBudget(), "dist/extra.d.ts": Buffer.from("export {};\n") };
    expect(() => runPack(files)).toThrow("code files 3 exceed 2");
  });

  it("refuses docs whose packed bytes exceed the docs cap", () => {
    const files = { ...withinBudget(), "AGENTS.md": randomBytes(1500) };
    expect(() => runPack(files)).toThrow(/^docs packed bytes \d+ exceed 1024$/);
  });

  it("refuses one docs file more than the docs cap", () => {
    const files = { ...withinBudget(), "LICENSE": Buffer.from("licence\n") };
    expect(() => runPack(files)).toThrow("docs files 3 exceed 2");
  });

  it("counts a file outside both classes only toward the tarball total", () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    const files = { ...withinBudget(), "assets/logo.png": randomBytes(8000) };

    expect(() => runPack(files)).not.toThrow();
    expect(() => runPack({ ...files, "assets/icon.png": Buffer.from("x") })).toThrow(
      "pack files 6 exceed 5",
    );
    expect(() => runPack({ ...files, "assets/big.png": randomBytes(9000) })).toThrow(
      /^unpacked bytes \d+ exceed 16384$/,
    );
  });

  it("refuses a tarball whose packed bytes exceed the total backstop", () => {
    expect(() => runPack(withinBudget(), { size: 4097 })).toThrow(
      "packed bytes 4097 exceed 4096",
    );
  });

  it("refuses a tarball without its agent guide", () => {
    const files = withinBudget();
    delete files["AGENTS.md"];
    expect(() => runPack(files)).toThrow("packed artifact is missing AGENTS.md");
  });
});
