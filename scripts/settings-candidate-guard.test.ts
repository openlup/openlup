import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import {
  checkSettingsCandidates,
  findUnaccountedSettingsCandidates,
  isSettingsCandidateSourcePath,
} from "./settings-candidate-guard.ts";

function makeDiff(path: string, hunkBody: string, startLine = 10): string {
  return [
    `diff --git a/${path} b/${path}`,
    `--- a/${path}`,
    `+++ b/${path}`,
    `@@ -${startLine},2 +${startLine},4 @@`,
    hunkBody,
  ].join("\n");
}

describe("isSettingsCandidateSourcePath", () => {
  it("matches non-test TypeScript files under packages/platform/src/<domain>/", () => {
    expect(isSettingsCandidateSourcePath("packages/platform/src/inventory/policy.ts")).toBe(true);
    expect(isSettingsCandidateSourcePath("packages/platform/src/commerce/nested/limits.ts")).toBe(true);
    expect(isSettingsCandidateSourcePath("packages/platform/src/inventory/policy.test.ts")).toBe(false);
    expect(isSettingsCandidateSourcePath("packages/platform/src/inventory/settings-data.json")).toBe(false);
    expect(isSettingsCandidateSourcePath("packages/platform/src/index.ts")).toBe(false);
    expect(isSettingsCandidateSourcePath("packages/core/src/pricing/limits.ts")).toBe(false);
  });
});

describe("findUnaccountedSettingsCandidates", () => {
  it.each([
    "DEFAULT_RETRY_WINDOW",
    "CHECKOUT_HOLD_MINUTES",
    "GRACE_PERIOD_DAYS",
    "EDIT_CUTOFF_HOURS",
    "LEASE_TTL_SECONDS",
    "FREE_SHIPPING_THRESHOLD",
    "BATCH_CLAIM_LIMIT",
    "SUBSCRIPTION_DISCOUNT_BPS",
    "SHIPPING_FLAT_MINOR",
  ])("flags newly added exported constant %s without settings-data.json or annotation", (symbol) => {
    const path = "packages/platform/src/commerce/policy.ts";
    const diff = makeDiff(path, ` export const existing = 1;\n+export const ${symbol} = 42;`, 10);

    const findings = findUnaccountedSettingsCandidates(diff, [path]);
    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({
      path,
      line: 11,
      symbol,
      domain: "commerce",
    });
    expect(findings[0].remediation).toContain("packages/platform/src/commerce/settings-data.json");
    expect(findings[0].remediation).toContain("settings-candidate: excluded");
  });

  it("passes when the owning domain settings-data.json is in changedPaths", () => {
    const path = "packages/platform/src/inventory/policy.ts";
    const diff = makeDiff(path, "+export const DEFAULT_HORIZON_DAYS = 14;");

    expect(
      findUnaccountedSettingsCandidates(diff, [
        path,
        "packages/platform/src/inventory/settings-data.json",
      ]),
    ).toEqual([]);

    // Changing a different domain's settings-data.json does not exempt inventory.
    expect(
      findUnaccountedSettingsCandidates(diff, [
        path,
        "packages/platform/src/commerce/settings-data.json",
      ]),
    ).toHaveLength(1);
  });

  it("passes when annotated within 2 lines above with excluded or planned reason", () => {
    const path = "packages/platform/src/subscriptions/policy.ts";
    const diff = makeDiff(
      path,
      [
        "+// settings-candidate: excluded (internal transport buffer cap, not business policy)",
        "+export const DEFAULT_TRANSPORT_LIMIT = 100;",
        " // settings-candidate: planned (wave-2-settings-scope)",
        "+const helper = 1;",
        "+export const RENEWAL_GRACE_HOURS = 24;",
      ].join("\n"),
      20,
    );

    expect(findUnaccountedSettingsCandidates(diff, [path])).toEqual([]);
  });

  it("rejects empty annotation reasons and annotations more than 2 lines above", () => {
    const path = "packages/platform/src/subscriptions/policy.ts";
    const diff = makeDiff(
      path,
      [
        "+// settings-candidate: excluded (   )",
        "+export const DEFAULT_EMPTY_REASON = 1;",
        "+// settings-candidate: planned (wave-2)",
        "+const lineOne = 1;",
        "+const lineTwo = 2;",
        "+export const TOO_FAR_DAYS = 7;",
      ].join("\n"),
      30,
    );

    const findings = findUnaccountedSettingsCandidates(diff, [path]);
    expect(findings.map(({ symbol, line }) => ({ symbol, line }))).toEqual([
      { symbol: "DEFAULT_EMPTY_REASON", line: 31 },
      { symbol: "TOO_FAR_DAYS", line: 35 },
    ]);
  });

  it("ignores context lines, deleted lines, comments, tests, non-platform paths, and non-candidate names", () => {
    const diff = [
      makeDiff(
        "packages/platform/src/commerce/policy.ts",
        [
          " export const DEFAULT_UNCHANGED_DAYS = 30;",
          "-export const DEFAULT_REMOVED_MINUTES = 15;",
          "+// export const DEFAULT_COMMENTED_DAYS = 10;",
          "+/* export const BLOCK_COMMENT_MINUTES = 5; */",
          "+ * export const JSDOC_LIMIT = 5;",
          "+const DEFAULT_INTERNAL_MINUTES = 10;",
          "+export const fixtureFreshness = 1;",
          "+export const MAX_RETRIES = 3;",
        ].join("\n"),
      ),
      makeDiff("packages/platform/src/commerce/policy.test.ts", "+export const DEFAULT_TEST_DAYS = 5;"),
      makeDiff("packages/core/src/pricing/policy.ts", "+export const DEFAULT_CORE_DAYS = 5;"),
    ].join("\n");

    expect(findUnaccountedSettingsCandidates(diff, [])).toEqual([]);
  });
});

describe("checkSettingsCandidates on a git fixture", () => {
  const dirs: string[] = [];

  afterEach(() => {
    while (dirs.length > 0) {
      rmSync(dirs.pop()!, { recursive: true, force: true });
    }
  });

  it("checks both tracked git diffs and untracked platform source files", () => {
    const root = mkdtempSync(join(tmpdir(), "openlup-settings-guard-"));
    dirs.push(root);
    const git = (...args: string[]) =>
      execFileSync("git", args, { cwd: root, encoding: "utf8" }).trim();

    git("init", "-q");
    git("config", "user.name", "Fixture");
    git("config", "user.email", "fixture@example.invalid");
    git("config", "commit.gpgSign", "false");

    const trackedPath = "packages/platform/src/commerce/policy.ts";
    mkdirSync(join(root, "packages/platform/src/commerce"), { recursive: true });
    writeFileSync(join(root, trackedPath), "export const existing = 1;\n");
    git("add", "-A");
    git("commit", "-qm", "Base commit");
    const base = git("rev-parse", "HEAD");

    // Modify tracked file with an unaccounted candidate.
    writeFileSync(
      join(root, trackedPath),
      "export const existing = 1;\nexport const CHECKOUT_TIMEOUT_SECONDS = 300;\n",
    );

    // Add two untracked files: one unaccounted, one annotated.
    const untrackedUnaccounted = "packages/platform/src/inventory/new-policy.ts";
    const untrackedAnnotated = "packages/platform/src/inventory/annotated-policy.ts";
    mkdirSync(join(root, "packages/platform/src/inventory"), { recursive: true });
    writeFileSync(join(root, untrackedUnaccounted), "export const DEFAULT_HORIZON_DAYS = 7;\n");
    writeFileSync(
      join(root, untrackedAnnotated),
      "// settings-candidate: excluded (internal buffer size)\nexport const DEFAULT_BUFFER_LIMIT = 64;\n",
    );

    const changes = [
      { path: trackedPath, deleted: false },
      { path: untrackedUnaccounted, deleted: false },
      { path: untrackedAnnotated, deleted: false },
    ];
    const untracked = new Set([untrackedUnaccounted, untrackedAnnotated]);

    const findings = checkSettingsCandidates(root, base, changes, { untracked });
    expect(findings.map(({ path, line, symbol, domain }) => ({ path, line, symbol, domain }))).toEqual([
      {
        path: trackedPath,
        line: 2,
        symbol: "CHECKOUT_TIMEOUT_SECONDS",
        domain: "commerce",
      },
      {
        path: untrackedUnaccounted,
        line: 1,
        symbol: "DEFAULT_HORIZON_DAYS",
        domain: "inventory",
      },
    ]);

    // Adding the domain settings-data.json to changes clears that domain's finding.
    const afterCatalogUpdate = checkSettingsCandidates(
      root,
      base,
      [...changes, { path: "packages/platform/src/commerce/settings-data.json", deleted: false }],
      { untracked },
    );
    expect(afterCatalogUpdate.map(({ symbol }) => symbol)).toEqual(["DEFAULT_HORIZON_DAYS"]);
  });
});
