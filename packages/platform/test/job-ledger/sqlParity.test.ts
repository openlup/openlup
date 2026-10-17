import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";

import { JOB_RUN_LEDGER_MIGRATIONS, JOB_RUN_LEDGER_SQL_URL, JOB_RUN_LEDGER_V3_SQL_URL } from "../../src/job-ledger/sql.js";
import { createPostgresPlatformJobRunLedger } from "../../src/job-ledger/postgres.js";
import {
  createManagedJobRunCalls,
  createSupabasePlatformJobRunLedger,
  type PlatformJobSupabaseClient,
} from "../../src/job-ledger/supabase.js";

// Every managed call and the PostgreSQL ledger name a function the shipped SQL defines and pass
// only its parameters; the v3 entry points delegate to the shipped v2 functions.

function functionParameters(sql: string): Map<string, string[]> {
  const functions = new Map<string, string[]>();
  for (const match of sql.matchAll(/CREATE (?:OR REPLACE )?FUNCTION public\.(\w+)\(([\s\S]*?)\)\s*RETURNS/g)) {
    const parameters = [...match[2]!.matchAll(/\b(p_\w+)\s+\w/g)].map((parameter) => parameter[1]!);
    functions.set(match[1]!, parameters);
  }
  return functions;
}

const shipped = functionParameters(readFileSync(JOB_RUN_LEDGER_SQL_URL, "utf8"));
const shippedV3 = functionParameters(readFileSync(JOB_RUN_LEDGER_V3_SQL_URL, "utf8"));

function recordingClient() {
  const calls: Array<{ name: string; args: Record<string, unknown> }> = [];
  const client = {
    rpc: vi.fn(async (name: string, args: Record<string, unknown>) => {
      calls.push({ name, args });
      return { data: name.startsWith("platform_claim") ? [{ acquired: true, run_id: "run", reason: "acquired" }] : true, error: null };
    }),
  } as unknown as PlatformJobSupabaseClient;
  return { client, calls };
}

const options = {
  releaseCorrelation: () => ({ releaseSha: null }),
  defaultFailureReason: "job_failed",
  backstopReadError: "backstop_read_failed",
  checkpointReadError: "checkpoint_read_failed",
};
const summary = { checked: 1, updated: 1, failures: 0, skipped: false };

describe("managed v2 calls against the shipped job-run ledger SQL", () => {
  it("parses the shipped v2 function signatures", () => {
    expect(shipped.get("platform_claim_job_run")).toEqual(["p_job_name", "p_driver", "p_lease_seconds", "p_metadata"]);
    expect(shipped.get("platform_finish_job_run_v2")).toEqual([
      "p_job_name", "p_run_id", "p_status", "p_checked", "p_updated", "p_error", "p_support_code", "p_metadata",
    ]);
  });

  it("calls only shipped functions with only their parameters, from the port and the compatibility calls", async () => {
    const { client, calls } = recordingClient();
    const ledger = createSupabasePlatformJobRunLedger(client, options);
    const invocation = { triggerKind: "scheduler", invocationSource: "pg_cron" } as const;
    await ledger.claimJobRun("nightly-report", invocation);
    await ledger.finishJobRun("nightly-report", "run", invocation, "failed", summary);
    const managed = createManagedJobRunCalls(options);
    await managed.claimJobRun(client, "nightly-report", "worker");
    await managed.finishJobRun(client, "nightly-report", "run", "success", summary);
    expect(calls.map(({ name }) => name)).toEqual([
      "platform_claim_job_run", "platform_finish_job_run_v2", "platform_claim_job_run", "platform_finish_job_run_v2",
    ]);
    for (const { name, args } of calls) {
      const parameters = shipped.get(name);
      expect(parameters, name).toBeDefined();
      expect(Object.keys(args).every((key) => parameters!.includes(key)), `${name} ${Object.keys(args).join(",")}`).toBe(true);
    }
  });
});

describe("v3 calls against the shipped v3 SQL", () => {
  it("orders the shipped migrations and defines exactly the two v3 entry points, which delegate to the v2 functions", () => {
    expect(JOB_RUN_LEDGER_MIGRATIONS.map(({ id }) => id)).toEqual(["20260809150000_job_run_ledger", "20260809150001_job_run_ledger_v3"]);
    expect([...shippedV3.keys()]).toEqual(["platform_claim_job_run_v3", "platform_finish_job_run_v3"]);
    const v3 = readFileSync(JOB_RUN_LEDGER_V3_SQL_URL, "utf8");
    expect(v3).toContain("FROM public.platform_claim_job_run(");
    expect(v3).toContain("SELECT public.platform_finish_job_run_v2(");
  });

  it("passes only declared parameters from the managed v3 calls", async () => {
    const { client, calls } = recordingClient();
    const managed = createManagedJobRunCalls(options);
    await managed.claimJobRunV3(client, "nightly-report", { triggerKind: "worker", invocationSource: "worker" });
    await managed.finishJobRunV3(client, "nightly-report", "run", "failed", summary);
    expect(calls.map(({ name }) => name)).toEqual(["platform_claim_job_run_v3", "platform_finish_job_run_v3"]);
    for (const { name, args } of calls) {
      expect(Object.keys(args).filter((key) => !shippedV3.get(name)!.includes(key)), name).toEqual([]);
    }
  });

  it("passes one positional argument per declared parameter from the PostgreSQL ledger", async () => {
    const query = vi.fn(async (_text: string, _values?: unknown[]) => ({ rows: [{ acquired: true, run_id: "run", reason: "acquired", released: true }] }));
    const ledger = createPostgresPlatformJobRunLedger({ query }, { releaseCorrelation: () => ({}), defaultFailureReason: "job_failed" });
    const invocation = { triggerKind: "worker", invocationSource: "worker" } as const;
    await ledger.claimJobRun("nightly-report", invocation);
    await ledger.finishJobRun("nightly-report", "run", invocation, "success", summary);
    const [claim, finish] = query.mock.calls;
    expect(claim![0]).toContain("public.platform_claim_job_run_v3(");
    expect(claim![1]).toHaveLength(shippedV3.get("platform_claim_job_run_v3")!.length);
    expect(finish![0]).toContain("public.platform_finish_job_run_v3(");
    expect(finish![1]).toHaveLength(shippedV3.get("platform_finish_job_run_v3")!.length);
  });
});
