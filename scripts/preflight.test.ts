import { execFileSync, spawnSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("node:child_process", async (original) => {
  const actual = await original<typeof import("node:child_process")>();
  return { ...actual, execFileSync: vi.fn(actual.execFileSync), spawnSync: vi.fn(actual.spawnSync) };
});

import {
  addedLines, formatCheckLine, isTestEntry, isTestFile, missingFragments, nearDates, parseNameStatus,
  main, neutralityVerdict, releasedPackageSource, separateTestFiles, shortExpiries, sqlTreeChanges,
  testDiscoveryVerdict, vitestFiles, type AddedLine, type Change,
} from "./preflight.ts";

afterEach(() => {
  vi.mocked(execFileSync).mockReset();
  vi.mocked(spawnSync).mockReset();
  vi.restoreAllMocks();
});

const changed = (...paths: string[]): Change[] => paths.map((path) => ({ path, deleted: false }));
const line = (text: string): AddedLine[] => [{ path: "scripts/example.test.ts", line: 7, text }];
// An injected clock; the window is measured from it, never from the real clock.
const now = new Date("2040-01-01T00:00:00Z");

describe("fast preflight", () => {
  it.each([
    { name: "clean", dirty: false, offline: false, warnings: false, failures: [], exit: 0 },
    { name: "clean with Git stderr warnings", dirty: false, offline: false, warnings: true, failures: [], exit: 0 },
    { name: "dirty with a failed fetch", dirty: true, offline: true, warnings: false, failures: ["clean"], exit: 1 },
    { name: "multiple failures", dirty: false, offline: false, warnings: false, failures: ["merge-clean", "neutrality", "dco"], exit: 1 },
  ])("reports every check and ends with JSON for a $name fixture", ({ dirty, offline, warnings, failures, exit }) => {
    const head = "a".repeat(40), fork = "b".repeat(40), upstream = "c".repeat(40);
    const increase = '"scripts/example.ts": brand increased 0 -> 1';
    const expected = [
      "git rev-parse --show-toplevel",
      "git rev-parse HEAD",
      "git fetch origin main",
      "git status --porcelain --untracked-files=all",
      "git merge-tree --write-tree origin/main HEAD",
      "git merge-base HEAD origin/main",
      `${process.execPath} scripts/public-ci-neutrality.mjs --base-commit ${fork}`,
      `${process.execPath} --experimental-strip-types packages/ui/smoke/neutrality.ts`,
      "npx --no -- ast-grep scan --error=no-suppress-all --error=unused-suppression",
      "npm run oss:published-tree -- --policy",
      "npm run oss:published-tree -- --inventory",
      "git rev-parse origin/main",
    ];
    const calls: string[] = [];
    const outputs = new Map([
      [expected[0], process.cwd()], [expected[1], head], [expected[3], dirty ? "?? local.txt\n" : ""],
      [expected[4], "CONFLICT (content): Merge conflict in example.ts"], [expected[5], fork],
      [expected[6], increase], [expected[11], upstream],
    ]);
    vi.mocked(spawnSync).mockImplementation(((bin, args) => {
      const call = `${bin} ${(args ?? []).join(" ")}`;
      calls.push(call);
      const status = Number((call === expected[2] && offline)
        || (call === expected[4] && failures.includes("merge-clean"))
        || (call === expected[6] && failures.includes("neutrality")));
      const stderr = warnings && [expected[0], expected[1], expected[3], expected[5], expected[11]].includes(call)
        ? "warning: fixture Git warning\n" : "";
      return { status, stdout: outputs.get(call) ?? "", stderr };
    }) as typeof spawnSync);
    const message = failures.includes("dco") ? "unsigned commit" : "change\n\nSigned-off-by: Test Fixture <fixture@example.invalid>";
    vi.mocked(execFileSync).mockReturnValue(`${head}\x1f${fork}\x1f${message}\0${upstream}\x1f${head} ${fork}\x1funsigned merge\0`);
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const stderr = vi.spyOn(console, "error").mockImplementation(() => {});

    expect(main(now, ["--fast"])).toBe(exit);
    expect(calls).toEqual(expected);
    expect(execFileSync).toHaveBeenCalledWith("git", expect.arrayContaining([`${upstream}..${head}`]), expect.anything());
    const lines = log.mock.calls.map(([value]) => String(value));
    expect(JSON.parse(lines.pop()!)).toEqual({ preflight: "fast", result: exit === 0 ? "pass" : "fail", head, failed: failures });
    const reasons: Record<string, string> = {
      clean: "worktree has uncommitted changes. Commit or remove them.",
      "merge-clean": "CONFLICT (content): Merge conflict in example.ts",
      neutrality: "1 neutrality count increase(s) against the fork point; the required self-check job refuses them",
      dco: `missing Signed-off-by on ${head.slice(0, 12)}`,
    };
    expect(lines.filter((line) => !line.startsWith("    ")).map((line) => line.replace(/ \(\d+ s\)$/u, "")))
      .toEqual(["clean", "merge-clean", "neutrality", "ui-neutrality", "ast-grep", "publication-policy", "publication-inventory", "dco"]
        .map((name) => `${name}: ${failures.includes(name) ? `FAIL ${reasons[name]}` : "ok"}`));
    expect(lines.filter((line) => line.startsWith("    "))).toEqual(failures.includes("neutrality") ? [`    ${increase}`] : []);
    expect(stderr.mock.calls).toEqual(offline ? [["preflight: git fetch origin main failed. Using local origin/main."]] : []);
  });
});

describe("preflight report", () => {
  it("confirms a real root test while leaving a wrong suffix undiscovered", async () => {
    const actual = await vi.importActual<typeof import("node:child_process")>("node:child_process");
    vi.mocked(spawnSync).mockImplementation(actual.spawnSync);
    expect(vitestFiles(["scripts/preflight.test.ts", "scripts/preflight.test.tsx"]))
      .toEqual(["scripts/preflight.test.ts"]);
    expect(vitestFiles(["packages/core/test/agent-context-cli.test.ts", "packages/core/test/agent-context-cli.test.tsx"], "packages/core/vitest.config.ts"))
      .toEqual(["packages/core/test/agent-context-cli.test.ts"]);
  });
  it("reports cheap failures before package builds and still retains the build failure", () => {
    const calls: string[] = [];
    vi.mocked(spawnSync).mockImplementation(((command, args) => {
      const call = `${command} ${(args ?? []).join(" ")}`; calls.push(call);
      let stdout = ""; let status = 0;
      if (command === "git") {
        if (args?.includes("--show-toplevel")) stdout = process.cwd();
        else if (args?.includes("merge-base")) stdout = "a".repeat(40);
      } else if (call.includes("ast-grep")) { stdout = "planted structural fault"; status = 1; }
      else if (call.includes("public-ci-neutrality")) { stdout = '"scripts/example.ts": brand increased 0 -> 1'; status = 1; }
      else if (call === "npm run prelint") { stdout = "broken package build"; status = 9; }
      else if (command === "gitleaks") return { status: null, stdout: "", stderr: "", error: Object.assign(new Error("missing"), { code: "ENOENT" }) };
      return { status, stdout, stderr: "" };
    }) as typeof spawnSync);
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    expect(main(now)).toBe(1);
    const build = calls.indexOf("npm run prelint");
    expect(build).toBeGreaterThan(calls.findIndex((call) => call.includes("ast-grep")));
    expect(build).toBeGreaterThan(calls.findIndex((call) => call.includes("public-ci-neutrality")));
    expect(log.mock.calls.flat().join("\n")).toContain("FAIL typecheck: package build (npm run prelint) failed");
    expect(calls.some((call) => call.includes("--typecheck"))).toBe(false);
  });

  it("distinguishes undiscovered tests from confirmed separate suites and discovered files", () => {
    const report = testDiscoveryVerdict({ files: ["scripts/collected.test.ts"],
      separate: [{ path: "packages/core/test/separate.test.ts", command: "owning discovery command" }],
      unknown: ["scripts/misnamed.test.tsx", "tests/unowned/new.test.ts"] });
    expect(report).toMatchObject({ check: "test discovery", status: "WARN" });
    expect(report.detail).toContain("execution remains missing proof");
    expect(report.notes?.join("\n")).toContain("check the suffix/location");
    expect(report.notes?.join("\n")).toContain("separate runner confirmed");
    expect(testDiscoveryVerdict({ files: ["scripts/collected.test.ts"], separate: [], unknown: [] })).toMatchObject({ status: "PASS" });
    expect(testDiscoveryVerdict({ files: [], separate: [], unknown: [] })).toMatchObject({ status: "SKIP" });
  });

  it("uses actual discovery results for package and browser ownership without executing their tests", () => {
    const commands: string[] = [];
    vi.mocked(spawnSync).mockImplementation(((command, args) => {
      commands.push(`${command} ${(args ?? []).join(" ")}`);
      if (command === "git") return { status: 0, stdout: "vitest.config.ts\0packages/core/vitest.config.ts\0playwright.checkout.config.ts\0", stderr: "" };
      if (args?.includes("vitest")) {
        const output = args.find((arg) => arg.startsWith("--json="))!.slice("--json=".length);
        writeFileSync(output, JSON.stringify([{ file: `${process.cwd()}/packages/core/test/separate.test.ts` }]));
        return { status: 0, stdout: "", stderr: "" };
      }
      return { status: 0, stdout: JSON.stringify({ config: { rootDir: `${process.cwd()}/tests/preview/checkout` }, suites: [{ file: "journey.spec.ts" }] }), stderr: "" };
    }) as typeof spawnSync);
    const candidates = ["packages/core/test/separate.test.ts", "packages/core/test/misnamed.test.tsx", "tests/preview/checkout/journey.spec.ts", "tests/unowned/new.test.ts"];
    expect(separateTestFiles(candidates).map(({ path }) => path)).toEqual(["packages/core/test/separate.test.ts", "tests/preview/checkout/journey.spec.ts"]);
    expect(commands.filter((command) => command.includes("npx")).every((command) => command.includes(" list ") || command.includes(" --list "))).toBe(true);
    expect(commands.join("\n")).not.toContain("npm test");
  });

  it("keeps a separate runner's unavailable setup explicit as unconfirmed discovery", () => {
    vi.mocked(spawnSync).mockImplementation(((command) => command === "git"
      ? { status: 0, stdout: "playwright.checkout.config.ts\0", stderr: "" }
      : { status: 1, stdout: "", stderr: "owned profile setup required" }) as typeof spawnSync);
    expect(separateTestFiles(["tests/preview/checkout/journey.spec.ts"])).toEqual([]);
  });
  it("prints one status line per check", () => {
    expect(formatCheckLine({ check: "typecheck", status: "PASS", detail: "the tree compiles to its signed debt. (27 s)" }))
      .toBe("PASS typecheck: the tree compiles to its signed debt. (27 s)");
    expect(formatCheckLine({ check: "gitleaks", status: "SKIP", detail: "gitleaks is not on PATH", notes: ["ignored"] }))
      .toBe("SKIP gitleaks: gitleaks is not on PATH");
    expect(formatCheckLine({ check: "fragments", status: "WARN", detail: "x" })).toBe("WARN fragments: x");
    expect(formatCheckLine({ check: "hosted tests", status: "FAIL", detail: "y" })).toBe("FAIL hosted tests: y");
  });

  it("turns the neutrality ratchet's exit and output into one check line", () => {
    expect(neutralityVerdict(0, "Neutrality: 7410 text files, 57 binary files inventoried; 0 increases.", 12))
      .toEqual({ check: "neutrality", status: "PASS", detail: "no neutrality count increase against the fork point (12 s)" });
    // The ratchet can report one raised category twice; the line lists it once.
    const raised = ['"scripts/a.ts": ui-9 increased 0 -> 1', '"scripts/b.mjs": brand increased 2 -> 3', '"scripts/a.ts": ui-9 increased 0 -> 1',
      "Neutrality: 7416 text files, 57 binary files inventoried; 3 increases."].join("\n");
    expect(neutralityVerdict(1, raised, 13)).toEqual({
      check: "neutrality", status: "FAIL",
      detail: "2 neutrality count increase(s) against the fork point; the required self-check job refuses them (13 s)",
      notes: ['"scripts/a.ts": ui-9 increased 0 -> 1', '"scripts/b.mjs": brand increased 2 -> 3'],
    });
    expect(neutralityVerdict(1, "\nbaseline scanner pin drift: \"packages/ui/smoke/neutrality.ts\"\n", 2)).toEqual({
      check: "neutrality", status: "FAIL", detail: "the neutrality ratchet failed (2 s)", notes: ['baseline scanner pin drift: "packages/ui/smoke/neutrality.ts"'],
    });
  });

  it("reads name-status output with deletions and unusual names", () => {
    expect(parseNameStatus("M\0a b.ts\0D\0old.sql\0A\0new\ttab.ts\0")).toEqual([
      { path: "a b.ts", deleted: false }, { path: "old.sql", deleted: true }, { path: "new\ttab.ts", deleted: false },
    ]);
    expect(parseNameStatus("")).toEqual([]);
  });
});

describe("change-set triggers", () => {
  it("triggers the inventory refresh only for migration and package SQL", () => {
    expect(sqlTreeChanges([...changed(
      "db/platform/migrations/20400101000000_example.sql",
      "db/bootstrap/vanilla-pg/roles.sql",
      "packages/platform/sql/subscriptions/example.sql",
      "supabase/tests/example_test.sql",
      "scripts/fixtures/reviewed-m10/example.sql",
      "tests/postgres/managed-compat/adapter.sql",
      "db/platform/README.md",
    ), { path: "db/platform/migrations/20400101000001_removed.sql", deleted: true }])).toEqual([
      "db/platform/migrations/20400101000000_example.sql",
      "db/bootstrap/vanilla-pg/roles.sql",
      "packages/platform/sql/subscriptions/example.sql",
      "db/platform/migrations/20400101000001_removed.sql",
    ]);
  });

  it("asks for a fragment per released package whose source changed", () => {
    expect(missingFragments(changed("packages/platform/src/index.ts", "packages/core/src/a.ts", "packages/core/test/a.test.ts")))
      .toEqual(["packages/core", "packages/platform"]);
    expect(missingFragments(changed("packages/platform/src/index.ts", "packages/platform/changes/example.md"))).toEqual([]);
    // A fragment for another package, a nested path, another extension or a deleted fragment does not count.
    expect(missingFragments([...changed("packages/outbox/src/a.ts", "packages/core/changes/example.md",
      "packages/outbox/changes/nested/example.md", "packages/outbox/changes/example.txt"),
    { path: "packages/outbox/changes/old.md", deleted: true }])).toEqual(["packages/outbox"]);
    // Unreleased packages and non-source paths take no fragment.
    expect(missingFragments(changed("packages/ui/src/index.ts", "packages/platform/README.md", "src/app.ts"))).toEqual([]);
    expect(releasedPackageSource("packages/outbox/src/a.ts")).toBe("packages/outbox");
    expect(releasedPackageSource("packages/ui/src/index.ts")).toBeUndefined();
    expect(releasedPackageSource("packages/platform/test/a.test.ts")).toBeUndefined();
  });

  it("classifies test entries and test-directory helpers", () => {
    for (const path of ["scripts/a.test.ts", "src/b.spec.tsx", "packages/core/test/c.test.mjs", "tests/postgres/cases.ts", "packages/platform/test/helpers/fixture.ts"]) {
      expect(isTestFile(path)).toBe(true);
    }
    for (const path of ["scripts/preflight.ts", "tests/postgres/inventory.json", "supabase/tests/example_test.sql", "docs/testing.md"]) {
      expect(isTestFile(path)).toBe(false);
    }
    expect(isTestEntry("tests/postgres/cases.ts")).toBe(false);
    expect(isTestEntry("scripts/a.test.ts")).toBe(true);
  });

  it("reads added lines with their new line numbers from a zero-context diff", () => {
    const diff = [
      "diff --git a/x.test.ts b/x.test.ts", "index 1..2 100644", "--- a/x.test.ts", "+++ b/x.test.ts",
      "@@ -3 +3 @@ describe", "-old", "+new", "@@ -10,0 +11,2 @@", "+first", "++second", "\\ No newline at end of file",
    ].join("\n");
    expect(addedLines("x.test.ts", diff)).toEqual([
      { path: "x.test.ts", line: 3, text: "new" },
      { path: "x.test.ts", line: 11, text: "first" },
      { path: "x.test.ts", line: 12, text: "+second" },
    ]);
  });
});

describe("dates near the injected clock", () => {
  it("warns within 400 days either side, inclusive", () => {
    expect(nearDates(line('const at = "2040-03-01T10:00:00Z";'), now)).toEqual([
      { path: "scripts/example.test.ts", line: 7, text: 'const at = "2040-03-01T10:00:00Z";', reason: "2040-03-01 within 400 days of now" },
    ]);
    expect(nearDates(line("2041-02-04 and 2038-11-27"), now)[0]?.reason).toBe("2041-02-04, 2038-11-27 within 400 days of now");
    expect(nearDates(line("2041-02-05 2038-11-26"), now)).toEqual([]);
  });

  it("ignores far dates, impossible dates and non-date digit runs", () => {
    for (const text of ["2001-02-03T04:05:06Z", "9999-12-31", "2040-02-30", "v2040-01-02", "2040-01-02-suffix", "20400102", "1.2040-01-02", "id 2040-12ab"]) {
      expect(nearDates(line(text), now)).toEqual([]);
    }
  });
});

describe("short expiries", () => {
  it.each([
    ["new SignJWT({}).setExpirationTime('5m')", "setExpirationTime 300 s"],
    ['sign(payload, key, { expiresIn: "60s" })', "expiresIn 60 s"],
    ["{ ttl: 300 }", "ttl 300 s"],
    ['"expires_in": 30,', "expires_in 30 s"],
    ["cacheTtlMs: 30_000,", "cacheTtlMs 30 s"],
    ["const TTL_SECONDS = 60;", "TTL_SECONDS 60 s"],
    ["maxAge: 9 * 60,", "maxAge 540 s"],
    ["cookieMaxAge: '2 minutes'", "cookieMaxAge 120 s"],
    ["expiresInMs: 500", "expiresInMs 0.5 s"],
  ])("warns on %s", (text, reason) => {
    expect(shortExpiries(line(text))[0]?.reason).toBe(`${reason} under 600 s`);
  });

  it.each([
    "setExpirationTime('2h')", "expiresIn: '10 minutes'", "ttl: 600,", "ttlMs: 15 * 60 * 1000,", "maxAge: 0,",
    "maxAge: 5 * MINUTE,", "settle: 5,", "subtitle: 3,", "expiresAt: Date.now() + 1000,", "ttl: '5 parsecs'",
    // A bare number followed by text is not evaluated.
    "token_expiry = 1500 ms",
  ])("does not warn on %s", (text) => {
    expect(shortExpiries(line(text))).toEqual([]);
  });
});
