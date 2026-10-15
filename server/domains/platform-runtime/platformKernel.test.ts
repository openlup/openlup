import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import { JOB_RUN_LEDGER_MIGRATIONS, JOB_RUN_LEDGER_SQL_URL, JOB_RUN_LEDGER_V3_SQL_URL } from "@openlup/platform/job-ledger";
import {
  DEFAULT_PLATFORM_BUNDLE as CONTRACT_DEFAULT_PLATFORM_BUNDLE,
  PLATFORM_BUNDLE_IDS as CONTRACT_PLATFORM_BUNDLE_IDS,
} from "../../../src/domains/platform-runtime/contracts.js";
import { DEFAULT_PLATFORM_BUNDLE, PLATFORM_BUNDLE_IDS, resolveBundleId } from "./platformKernel.js";

const REFERENCE_LEDGER_MIGRATION = "../../../db/platform/migrations/20260809150000_job_run_ledger.sql";
const REFERENCE_V3_MIGRATION = "../../../db/platform/migrations/20260809210000_accounting_document_rail.sql";

function functionStatements(sql: string): Map<string, string> {
  const statements = new Map<string, string>();
  for (const match of sql.matchAll(/CREATE (?:OR REPLACE )?FUNCTION public\.(\w+)\([\s\S]*?\nAS \$\$[\s\S]*?\n\$\$;/g)) {
    statements.set(match[1]!, match[0].replace(/^CREATE OR REPLACE FUNCTION /, "CREATE FUNCTION "));
  }
  return statements;
}

describe("reference platform kernel binding", () => {
  it("keeps the browser contract's bundle ids and default equal to the package kernel", () => {
    expect([...PLATFORM_BUNDLE_IDS]).toEqual([...CONTRACT_PLATFORM_BUNDLE_IDS]);
    expect(DEFAULT_PLATFORM_BUNDLE).toBe(CONTRACT_DEFAULT_PLATFORM_BUNDLE);
    expect(resolveBundleId({})).toBe(CONTRACT_DEFAULT_PLATFORM_BUNDLE);
  });

  it("ships the job-run ledger SQL with the exact bytes of the reference platform migration", () => {
    const packaged = readFileSync(JOB_RUN_LEDGER_SQL_URL);
    const reference = readFileSync(fileURLToPath(new URL(REFERENCE_LEDGER_MIGRATION, import.meta.url)));
    expect(packaged.equals(reference)).toBe(true);
  });

  it("ships the v3 claim and finish with the exact definitions of the reference chain", () => {
    const packaged = readFileSync(JOB_RUN_LEDGER_V3_SQL_URL, "utf8");
    const reference = functionStatements(readFileSync(fileURLToPath(new URL(REFERENCE_V3_MIGRATION, import.meta.url)), "utf8"));
    const shipped = functionStatements(packaged);
    expect([...shipped.keys()]).toEqual(["platform_claim_job_run_v3", "platform_finish_job_run_v3"]);
    expect(packaged.match(/CREATE OR REPLACE FUNCTION/g)).toHaveLength(2);
    const code = packaged.replace(/--.*$/gm, "");
    expect(code).not.toMatch(/\bCREATE (?!OR REPLACE FUNCTION)|\b(?:ALTER|DROP|GRANT|REVOKE|INSERT|UPDATE|DELETE)\b/);
    for (const [name, statement] of shipped) expect(statement, name).toBe(reference.get(name));
  });

  it("gives the package's own v3 migration an identity no reference migration uses", () => {
    const versions = (directory: string) => readdirSync(fileURLToPath(new URL(directory, import.meta.url)))
      .filter((file) => file.endsWith(".sql")).map((file) => file.split("_")[0]!);
    const reference = new Set([...versions("../../../db/platform/migrations/"), ...versions("../../../supabase/migrations/")]);
    const [ledger, v3] = JOB_RUN_LEDGER_MIGRATIONS;
    expect(reference.has(ledger!.id.split("_")[0]!)).toBe(true);
    expect(reference.has(v3!.id.split("_")[0]!)).toBe(false);
  });
});
