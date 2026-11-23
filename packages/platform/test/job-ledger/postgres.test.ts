import { describe, expect, it, vi } from "vitest";
import type { PgQueryExecutor } from "../../src/data/queryBuilder.js";
import { createPostgresPlatformJobRunLedger } from "../../src/job-ledger/postgres.js";

const claimSql = `
  SELECT acquired, run_id, reason
  FROM public.platform_claim_job_run_v3($1, $2, $3, $4, $5::jsonb)`;
const finishSql = `
  SELECT public.platform_finish_job_run_v3(
    $1, $2::uuid, $3, $4, $5, $6, $7, $8::jsonb
  ) AS released`;
const backstopSql = `
  SELECT last_status, last_success_at
  FROM public.platform_job_controls
  WHERE job_name = $1`;
const latestSql = `
  SELECT metadata
  FROM public.platform_job_runs
  WHERE job_name = $1
    AND status IN ('success', 'failed')
    AND finished_at IS NOT NULL
  ORDER BY started_at DESC
  LIMIT 1`;
const invocation = { triggerKind: "scheduler", invocationSource: "  scheduled-entry  " } as const;
const summary = { checked: 7, updated: 4, failures: 0, skipped: false };
const runId = "00000000-0000-4000-8000-000000000001";

function fixture(rows: unknown[] = []) {
  const query = vi.fn(async (_text: string, _values?: unknown[]) => ({
    rows: rows as Record<string, unknown>[],
  }));
  const releaseCorrelation = vi.fn(() => ({
    releaseSha: "revision-one",
    deploymentUrl: "https://assets.example.test",
  }));
  const executor: PgQueryExecutor = { query };
  const ledger = createPostgresPlatformJobRunLedger(executor, {
    releaseCorrelation,
    defaultFailureReason: "job_execution_failed",
  });
  return { query, releaseCorrelation, ledger, executor };
}

describe("PostgreSQL job-run ledger", () => {
  it("claims with exact parameterized SQL, a trimmed source and caller lease", async () => {
    const { ledger, query, releaseCorrelation } = fixture([
      { acquired: true, run_id: runId, reason: "acquired" },
    ]);
    await expect(ledger.claimJobRun("queue-drain", invocation, 120)).resolves.toEqual({
      acquired: true, runId, reason: "acquired",
    });
    expect(query.mock.calls).toEqual([[claimSql, [
      "queue-drain", "scheduler", "scheduled-entry", 120,
      {
        triggerKind: "scheduler", invocationSource: "scheduled-entry",
        releaseSha: "revision-one", deploymentUrl: "https://assets.example.test",
      },
    ]]]);
    expect(Object.keys(query.mock.calls[0]![1]![4] as object)).toEqual([
      "triggerKind", "invocationSource", "releaseSha", "deploymentUrl",
    ]);
    expect(releaseCorrelation).toHaveBeenCalledOnce();
  });

  it("defaults the lease to 900 and obtains release correlation for each operation", async () => {
    const { ledger, query, releaseCorrelation } = fixture([{ released: true }]);
    await ledger.claimJobRun("nightly-report", invocation);
    releaseCorrelation.mockReturnValue({ releaseSha: "revision-two", deploymentUrl: "https://reference.invalid" });
    await ledger.finishJobRun("nightly-report", runId, invocation, "success", summary);
    expect(query.mock.calls[0]![1]![3]).toBe(900);
    expect(query.mock.calls[1]![1]![7]).toMatchObject({
      releaseSha: "revision-two", deploymentUrl: "https://reference.invalid",
    });
    expect(releaseCorrelation).toHaveBeenCalledTimes(2);
  });

  it("preserves claim metadata insertion order and release-correlation precedence", async () => {
    const { executor, query } = fixture();
    const ledger = createPostgresPlatformJobRunLedger(executor, {
      releaseCorrelation: () => ({ triggerKind: "correlation-kind", invocationSource: "correlation-source", revision: null }),
      defaultFailureReason: "job_execution_failed",
    });
    await ledger.claimJobRun("queue-drain", invocation);
    expect(query).toHaveBeenCalledWith(claimSql, [
      "queue-drain", "scheduler", "scheduled-entry", 900,
      { triggerKind: "correlation-kind", invocationSource: "correlation-source", revision: null },
    ]);
    expect(Object.keys(query.mock.calls[0]![1]![4] as object)).toEqual([
      "triggerKind", "invocationSource", "revision",
    ]);
  });

  it("finishes with exact SQL and authoritative invocation fields after extra metadata", async () => {
    const { executor, query } = fixture([{ released: true }]);
    const ledger = createPostgresPlatformJobRunLedger(executor, {
      releaseCorrelation: () => ({
        releaseSha: "revision-one", deploymentUrl: null, reason: "correlation-reason",
        triggerKind: "correlation-kind", invocationSource: "correlation-source", driver: "correlation-driver",
      }),
      defaultFailureReason: "job_execution_failed",
    });
    await expect(ledger.finishJobRun("queue-drain", runId, invocation, "success", summary, {
      checkpoint: "offset-8", releaseSha: "extra-revision", failures: 9, skipped: true,
      reason: "extra-reason", triggerKind: "extra-kind", invocationSource: "extra-source", driver: "extra-driver",
    })).resolves.toBe(true);
    expect(query.mock.calls).toEqual([[finishSql, [
      "queue-drain", runId, "success", 7, 4, null, null,
      {
        failures: 9, skipped: true, reason: "extra-reason", releaseSha: "extra-revision", deploymentUrl: null,
        triggerKind: "scheduler", invocationSource: "scheduled-entry", driver: "scheduled-entry", checkpoint: "offset-8",
      },
    ]]]);
    expect(Object.keys(query.mock.calls[0]![1]![7] as object)).toEqual([
      "failures", "skipped", "reason", "releaseSha", "deploymentUrl",
      "triggerKind", "invocationSource", "driver", "checkpoint",
    ]);
  });

  it.each([
    ["failed", undefined, "job_execution_failed"],
    ["failed", "explicit-failure", "explicit-failure"],
    ["failed", "", ""],
    ["success", undefined, null],
    ["success", "observed-reason", null],
  ] as const)("records failure reason for %s with summary reason %s", async (status, reason, expected) => {
    const { ledger, query } = fixture([{ released: true }]);
    await ledger.finishJobRun("nightly-report", runId, invocation, status, {
      ...summary, failures: 2, skipped: true, ...(reason === undefined ? {} : { reason }),
    });
    expect(query).toHaveBeenCalledWith(finishSql, [
      "nightly-report", runId, status, 7, 4, expected, null,
      {
        failures: 2, skipped: true, reason: reason ?? null,
        releaseSha: "revision-one", deploymentUrl: "https://assets.example.test",
        triggerKind: "scheduler", invocationSource: "scheduled-entry", driver: "scheduled-entry",
      },
    ]);
  });

  it.each(["", " \t\n"])("refuses a blank invocation source %j before querying or correlation", async (source) => {
    const { ledger, query, releaseCorrelation } = fixture();
    const blank = { ...invocation, invocationSource: source };
    await expect(ledger.claimJobRun("queue-drain", blank)).rejects.toThrow(/^platform_job_invocation_source_required$/);
    await expect(ledger.finishJobRun("queue-drain", runId, blank, "failed", summary))
      .rejects.toThrow(/^platform_job_invocation_source_required$/);
    expect(query).not.toHaveBeenCalled();
    expect(releaseCorrelation).not.toHaveBeenCalled();
  });

  it.each([undefined, null, [], "row", 5, { acquired: 1, run_id: 8, reason: false }].map((row) => ({ row })))(
    "normalizes absent or malformed claim and finish rows: $row", async ({ row }) => {
      const { ledger } = fixture(row === undefined ? [] : [row]);
      await expect(ledger.claimJobRun("queue-drain", invocation)).resolves.toEqual({
        acquired: false, runId: null, reason: "unknown",
      });
      await expect(ledger.finishJobRun("queue-drain", runId, invocation, "success", summary)).resolves.toBe(false);
    },
  );

  it("retains refused claim details and requires a literal true release", async () => {
    const { ledger } = fixture([{ acquired: false, run_id: "prior-run", reason: "lease_held", released: "true" }]);
    await expect(ledger.claimJobRun("queue-drain", invocation)).resolves.toEqual({
      acquired: false, runId: "prior-run", reason: "lease_held",
    });
    await expect(ledger.finishJobRun("queue-drain", runId, invocation, "success", summary)).resolves.toBe(false);
  });

  it.each([
    [new Date("2030-01-02T03:04:05Z"), "2030-01-02T03:04:05.000Z"],
    ["2030-01-02 03:04:05+00", "2030-01-02 03:04:05+00"],
    [null, null],
    [42, null],
  ])("reads backstop timestamps without changing strings: %j", async (timestamp, expected) => {
    const { ledger, query } = fixture([{ last_status: "success", last_success_at: timestamp }]);
    await expect(ledger.readJobBackstopState("nightly-report")).resolves.toEqual({
      lastStatus: "success", lastSuccessAt: expected,
    });
    expect(query.mock.calls).toEqual([[backstopSql, ["nightly-report"]]]);
  });

  it("normalizes non-string backstop status fields", async () => {
    const { ledger } = fixture([{ last_status: true }]);
    await expect(ledger.readJobBackstopState("nightly-report")).resolves.toEqual({ lastStatus: null, lastSuccessAt: null });
  });

  it("reads the latest finished terminal metadata with exact parameterized ordering", async () => {
    const metadata = { checkpoint: "offset-9", nested: { count: 2 } };
    const { ledger, query } = fixture([{ metadata }, { metadata: { checkpoint: "older" } }]);
    const result = await ledger.readLatestTerminalRunMetadata("nightly-report");
    expect(result).toEqual(metadata);
    expect(result).not.toBe(metadata);
    expect(query.mock.calls).toEqual([[latestSql, ["nightly-report"]]]);
  });

  it.each([undefined, null, [], "row", 5].map((row) => ({ row })))("returns null for non-record readback rows: $row", async ({ row }) => {
    const { ledger } = fixture(row === undefined ? [] : [row]);
    await expect(ledger.readJobBackstopState("nightly-report")).resolves.toBeNull();
    await expect(ledger.readLatestTerminalRunMetadata("nightly-report")).resolves.toBeNull();
  });

  it.each([undefined, null, [], "metadata", 5].map((metadata) => ({ metadata })))("returns null for non-record metadata: $metadata", async ({ metadata }) => {
    const { ledger } = fixture([{ metadata }]);
    await expect(ledger.readLatestTerminalRunMetadata("nightly-report")).resolves.toBeNull();
  });

  it("propagates query failures from every ledger operation", async () => {
    const { ledger, query } = fixture();
    const failure = new Error("query unavailable");
    query.mockRejectedValue(failure);
    await expect(ledger.claimJobRun("queue-drain", invocation)).rejects.toBe(failure);
    await expect(ledger.finishJobRun("queue-drain", runId, invocation, "failed", summary)).rejects.toBe(failure);
    await expect(ledger.readJobBackstopState("queue-drain")).rejects.toBe(failure);
    await expect(ledger.readLatestTerminalRunMetadata("queue-drain")).rejects.toBe(failure);
  });
});
