import { spawnSync } from "node:child_process";
import { chmodSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { compareTapLogs, dockerExecutable, diffRows, parseRows, parseTapLog, sabotageSql, SABOTAGE, summariseTap } from "./pgtap-parity.mjs";

// Shape of `pg_prove --verbose` output: padded file header, plan, results, verdict.
const log = (path: string, body: string) => `${path} ........ \n${body}`;
const cli = [
  log("/host/run-a/supabase/tests/a_test.sql", "1..3\nok 1 - first\nok 2 - second # SKIP not here\nnot ok 3 - third # TODO later\n# Failed (TODO) test 3\nok"),
  log("/host/run-a/supabase/tests/b_test.sql", "1..1\nok 1 - only\nok"),
  "All tests successful.\nFiles=2, Tests=4,  1 wallclock secs\nResult: PASS\n",
].join("\n");
const stock = cli.replaceAll("/host/run-a/supabase/tests", "/work/tests");

describe("pg_prove TAP parsing", () => {
  it("keys files by basename and keeps ordered results, plan and directives", () => {
    const files = parseTapLog(cli);
    expect([...files.keys()]).toEqual(["a_test.sql", "b_test.sql"]);
    expect(files.get("a_test.sql")).toEqual({
      plan: 3, planDirective: "", verdict: "ok",
      assertions: [
        { ok: true, number: 1, description: "first", directive: "" },
        { ok: true, number: 2, description: "second", directive: "SKIP not here" },
        { ok: false, number: 3, description: "third", directive: "TODO later" },
      ],
    });
    expect(summariseTap(files)).toEqual({ files: 2, assertions: 4, notOk: 1, directives: 2, filesWithoutPlan: 0 });
  });

  it("ignores diagnostics, stderr noise and the summary, and keeps escaped hashes in descriptions", () => {
    const files = parseTapLog(log("t/c_test.sql", "psql:x.sql:1: NOTICE:  extension exists\n1..2\nok 1 - issue \\# 7 stays\n    indented subtest\nok 2\nFailed 1/2 subtests"));
    expect(files.get("c_test.sql")?.assertions.map(item => [item.description, item.directive])).toEqual([["issue \\# 7 stays", ""], ["", ""]]);
    expect(files.get("c_test.sql")?.verdict).toBe("Failed 1/2 subtests");
  });

  it("refuses a duplicated file entry", () => {
    expect(() => parseTapLog(`${cli}\n${log("x/a_test.sql", "1..0")}`)).toThrow(/duplicate TAP file entry: a_test.sql/u);
  });
});

describe("per-assertion lane comparison", () => {
  it("treats different scratch directories with identical results as identical", () => {
    expect(compareTapLogs(parseTapLog(cli), parseTapLog(stock))).toEqual([]);
  });

  it.each([
    ["an ok/not ok flip", stock.replace("ok 1 - only", "not ok 1 - only"), "b_test.sql #1: left ok 1 - only | right not ok 1 - only"],
    ["a changed description", stock.replace("ok 1 - first", "ok 1 - first!"), "a_test.sql #1: left ok 1 - first | right ok 1 - first!"],
    ["a lost SKIP marker", stock.replace("second # SKIP not here", "second"), "a_test.sql #2: left ok 2 - second # SKIP not here | right ok 2 - second"],
    ["a different plan", stock.replace("1..1\n", "1..2\n"), "b_test.sql: plan 1 != 2"],
    ["a missing assertion", stock.replace("ok 1 - only\n", ""), "b_test.sql #1: left ok 1 - only | right (missing)"],
    ["a reordered assertion", stock.replace("ok 1 - first\nok 2 - second # SKIP not here", "ok 2 - second # SKIP not here\nok 1 - first"), "a_test.sql #1: left ok 1 - first | right ok 2 - second # SKIP not here"],
  ])("reports %s", (_, right, expected) => {
    expect(compareTapLogs(parseTapLog(cli), parseTapLog(right))).toContain(expected);
  });

  it("fails a file present in one lane only", () => {
    const right = parseTapLog(stock);
    right.delete("b_test.sql");
    expect(compareTapLogs(parseTapLog(cli), right, ["cli", "postgres"])).toEqual(["b_test.sql: present only in cli"]);
  });
});

describe("catalog rows", () => {
  it("parses record-separated psql rows with embedded newlines", () => {
    expect(parseRows("a\tone\n\u001eauth-function\tCREATE FUNCTION f()\n RETURNS int\u001e")).toEqual([
      { section: "a", item: "one" },
      { section: "auth-function", item: "CREATE FUNCTION f()\n RETURNS int" },
    ]);
    expect(() => parseRows("no tab here\u001e")).toThrow(/malformed captured row/u);
  });

  it("reports set differences in both directions", () => {
    const left = [{ section: "role", item: "postgres super=false" }, { section: "schema", item: "auth" }];
    const right = [{ section: "role", item: "postgres super=true" }, { section: "schema", item: "auth" }];
    expect(diffRows(left, right)).toEqual(["- role\tpostgres super=false", "+ role\tpostgres super=true"]);
    expect(diffRows(left, [...left].reverse())).toEqual([]);
  });
});

describe("sabotage switches", () => {
  it("offers exactly the five planned switches and refuses others", () => {
    expect(Object.keys(SABOTAGE)).toEqual(["auth-uid-null", "drop-rls-policy", "revoke-service-role-grant", "no-pg-cron", "wrong-dblink-password"]);
    expect(sabotageSql(undefined)).toBe("");
    expect(sabotageSql("auth-uid-null")).toContain("SELECT NULL::uuid");
    expect(() => sabotageSql("drop-everything")).toThrow(/unknown sabotage/u);
  });
});

describe("executable resolution", () => {
  it("finds Docker only in the given fixed directories", () => {
    const empty = mkdtempSync(join(tmpdir(), "pgtap-parity-empty-")), fixed = mkdtempSync(join(tmpdir(), "pgtap-parity-bin-"));
    writeFileSync(join(fixed, "docker"), "#!/bin/sh\n");
    chmodSync(join(fixed, "docker"), 0o755);
    expect(dockerExecutable([empty, fixed])).toBe(join(fixed, "docker"));
    expect(() => dockerExecutable([empty])).toThrow(/docker not found/u);
  });

  it("refuses a CLI lane without an absolute --supabase path", () => {
    for (const args of [["cli-lane"], ["cli-lane", "--supabase", "supabase"]]) {
      const result = spawnSync(process.execPath, ["scripts/pgtap-parity.mjs", ...args], { encoding: "utf8" });
      expect(result.status).toBe(2);
      expect(result.stderr).toMatch(/--supabase <absolute path>/u);
    }
  });
});
