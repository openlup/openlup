import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";

import { claimJobRunV3, finishJobRunV3, type PlatformJobClient } from "./platformJobRunLedger.js";
import { createPostgresPlatformJobRunLedger } from "../postgres/platformJobRunLedger.js";

// The v3 job-control functions are defined by the reference platform migration chain (not by the
// package's job-run ledger SQL); the managed v3 calls and the PostgreSQL ledger must match them.
const V3_MIGRATION = "../../../db/platform/migrations/20260809210000_accounting_document_rail.sql";

function functionParameters(sql: string): Map<string, string[]> {
  const functions = new Map<string, string[]>();
  for (const match of sql.matchAll(/CREATE (?:OR REPLACE )?FUNCTION public\.(\w+)\(([\s\S]*?)\)\s*RETURNS/g)) {
    functions.set(match[1]!, [...match[2]!.matchAll(/\b(p_\w+)\s+\w/g)].map((parameter) => parameter[1]!));
  }
  return functions;
}

const v3 = functionParameters(readFileSync(fileURLToPath(new URL(V3_MIGRATION, import.meta.url)), "utf8"));
const invocation = { triggerKind: "worker", invocationSource: "worker" } as const;
const summary = { checked: 1, updated: 1, failures: 0, skipped: false };

describe("v3 job-control calls against the reference migration", () => {
  it("passes only declared parameters to the managed v3 functions", async () => {
    const calls: Array<{ name: string; args: Record<string, unknown> }> = [];
    const client = {
      rpc: vi.fn(async (name: string, args: Record<string, unknown>) => {
        calls.push({ name, args });
        return { data: [{ acquired: true, run_id: "run", reason: "acquired" }], error: null };
      }),
    } as unknown as PlatformJobClient;
    await claimJobRunV3(client, "nightly-report", invocation);
    await finishJobRunV3(client, "nightly-report", "run", "failed", summary);
    expect(calls.map(({ name }) => name)).toEqual(["platform_claim_job_run_v3", "platform_finish_job_run_v3"]);
    for (const { name, args } of calls) {
      expect(v3.get(name), name).toBeDefined();
      expect(Object.keys(args).filter((key) => !v3.get(name)!.includes(key))).toEqual([]);
    }
  });

  it("passes one positional argument per declared parameter from the PostgreSQL ledger", async () => {
    const query = vi.fn(async (_text: string, _values?: unknown[]) => ({ rows: [{ acquired: true, run_id: "run", reason: "acquired", released: true }] }));
    const ledger = createPostgresPlatformJobRunLedger({ query }, {});
    await ledger.claimJobRun("nightly-report", invocation);
    await ledger.finishJobRun("nightly-report", "run", invocation, "success", summary);
    const [claim, finish] = query.mock.calls;
    expect(claim![0]).toContain("public.platform_claim_job_run_v3(");
    expect(claim![1]).toHaveLength(v3.get("platform_claim_job_run_v3")!.length);
    expect(finish![0]).toContain("public.platform_finish_job_run_v3(");
    expect(finish![1]).toHaveLength(v3.get("platform_finish_job_run_v3")!.length);
  });
});
