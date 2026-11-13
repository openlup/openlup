import { describe, expect, it } from "vitest";

import {
  addedLines, formatCheckLine, isTestEntry, isTestFile, missingFragments, nearDates, parseNameStatus,
  neutralityVerdict, releasedPackageSource, shortExpiries, sqlTreeChanges, type AddedLine, type Change,
} from "./preflight.ts";

const changed = (...paths: string[]): Change[] => paths.map((path) => ({ path, deleted: false }));
const line = (text: string): AddedLine[] => [{ path: "scripts/example.test.ts", line: 7, text }];
// An injected clock; the window is measured from it, never from the real clock.
const now = new Date("2040-01-01T00:00:00Z");

describe("preflight report", () => {
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
