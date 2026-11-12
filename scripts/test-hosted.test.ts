import { spawnSync } from "node:child_process";
import { devNull } from "node:os";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

import { HOSTED_VITEST_WORKERS, hostedTestRun } from "./test-hosted.mjs";

const contributor = {
  PATH: "/usr/bin",
  HOME: "/home/contributor",
  CI: "1",
  GIT_AUTHOR_NAME: "Contributor",
  GIT_AUTHOR_EMAIL: "contributor@example.com",
  GIT_AUTHOR_DATE: "2001-02-03T04:05:06Z",
  GIT_COMMITTER_NAME: "Contributor",
  GIT_COMMITTER_EMAIL: "contributor@example.com",
  GIT_CONFIG_PARAMETERS: "'user.name'='Contributor'",
  GIT_CONFIG_COUNT: "2",
  GIT_CONFIG_KEY_0: "user.email",
  GIT_CONFIG_VALUE_0: "contributor@example.com",
  GIT_CONFIG_KEY_1: "init.defaultBranch",
  GIT_CONFIG_VALUE_1: "main",
  NODE_V8_COVERAGE: "/tmp/v8",
  VITEST_COVERAGE_DIR: "/tmp/coverage",
  VITEST_COVERAGE_SHARD: "1",
  OPENLUP_COVERAGE_PROOF_PATH: "/tmp/proof",
  OPENLUP_VITEST_COVERAGE_MAX_WORKERS: "8",
  COVERAGE_STAGE_PROOF_BINDING_PATH: "/tmp/binding",
  OPENLUP_VITEST_DURATIONS_FILE: "/tmp/durations.json",
  OPENLUP_VITEST_EXCLUDE_FILE: "/tmp/exclude.txt",
  OPENLUP_VITEST_MAX_WORKERS: "12",
  VITEST_MAX_WORKERS: "12",
};

describe("hosted-parity test runs", () => {
  it("builds the hosted shard environment from a contributor environment", () => {
    const run = hostedTestRun(["scripts/example.test.ts"], contributor);
    expect(run.command).toBe("npm");
    expect(run.args).toEqual(["test", "--", "scripts/example.test.ts"]);
    expect(run.env).toEqual({
      PATH: "/usr/bin",
      HOME: "/home/contributor",
      CI: "true",
      GIT_CONFIG_GLOBAL: devNull,
      GIT_CONFIG_COUNT: "1",
      GIT_CONFIG_KEY_0: "user.useConfigOnly",
      GIT_CONFIG_VALUE_0: "true",
      VITEST_MAX_WORKERS: HOSTED_VITEST_WORKERS,
    });
  });

  it("drops undefined values and keeps unrelated variables", () => {
    const run = hostedTestRun(["a.test.ts"], { LANG: "C", EMPTY: undefined, GITHUB_ACTIONS: "true" });
    expect(run.env).toMatchObject({ LANG: "C", GITHUB_ACTIONS: "true", CI: "true" });
    expect(run.env).not.toHaveProperty("EMPTY");
  });

  it("refuses to run without a test file", () => {
    for (const argv of [[], ["--coverage"], ["--testNamePattern=refuses", "--reporter=verbose"]]) {
      expect(hostedTestRun(argv, contributor)).toEqual({ refusal: expect.stringContaining("at least one test file") });
    }
    const cli = spawnSync(process.execPath, [resolve("scripts/test-hosted.mjs"), "--coverage"], { encoding: "utf8", timeout: 5_000 });
    expect(cli.status).toBe(2);
    expect(cli.stderr).toContain("needs at least one test file");
  });

  it("drops every coverage flag and keeps the other arguments in order", () => {
    const run = hostedTestRun(["--coverage", "a.test.ts", "--coverage.enabled=true", "--coverage.reporter=text",
      "--coverage=true", "b.test.ts", "--testNamePattern=keeps"], contributor);
    expect(run.args).toEqual(["test", "--", "a.test.ts", "b.test.ts", "--testNamePattern=keeps"]);
    expect(run.files).toEqual(["a.test.ts", "b.test.ts"]);
    expect(run.ignored).toEqual(["--coverage", "--coverage.enabled=true", "--coverage.reporter=text", "--coverage=true"]);
  });
});
