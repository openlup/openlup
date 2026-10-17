import { describe, expect, it, vi } from "vitest";
import type { PlatformJobInvocation } from "@openlup/core/platform-runtime";
import {
  createManagedJobRunCalls,
  createSupabasePlatformJobRunLedger,
  platformJobInvocationForDriver,
  type PlatformJobSupabaseClient,
} from "../../src/job-ledger/supabase.js";

const release = { releaseSha: "revision-7", deploymentUrl: "https://assets.example.test" };
const invocation = { triggerKind: "scheduler", invocationSource: "pg_cron" } as const;
const summary = { checked: 6, updated: 2, failures: 1, skipped: false };
const finishKeys = [
  "p_job_name", "p_run_id", "p_status", "p_checked", "p_updated", "p_error", "p_support_code", "p_metadata",
];
const drivers = [
  ["manual_admin", "operator", "manual_admin", "manual_admin"],
  ["pg_cron", "scheduler", "pg_cron_scheduler", "pg_cron"],
  ["vercel_cron", "scheduler", "vercel_cron", "vercel_cron_manual"],
  ["worker", "worker", "worker", "worker"],
] as const;

function query() {
  const trace: unknown[][] = [];
  const step = (name: string) => vi.fn((...args: unknown[]) => {
    trace.push([name, ...args]);
    return chain;
  });
  const chain = {
    select: step("select"), eq: step("eq"), in: step("in"), not: step("not"),
    order: step("order"), limit: step("limit"),
    maybeSingle: vi.fn(async (): Promise<{ data: unknown; error: { message?: string } | null }> => {
      return { data: null, error: null };
    }),
  };
  return { chain, trace };
}

function fixture(correlation: () => Record<string, string | null> = () => ({ ...release })) {
  const controls = query();
  const runs = query();
  const rpc = vi.fn(async (_name: string, _args: Record<string, unknown>): Promise<{
    data: unknown; error: { message?: string } | null;
  }> => ({ data: true, error: null }));
  const from = vi.fn((table: string) => {
    if (table === "platform_job_controls") return controls.chain;
    if (table === "platform_job_runs") return runs.chain;
    throw new Error("unexpected_table");
  });
  const client = { rpc, from } as unknown as PlatformJobSupabaseClient;
  const releaseCorrelation = vi.fn(correlation);
  const options = {
    releaseCorrelation, defaultFailureReason: "job_execution_failed",
    backstopReadError: "backstop_read_failed", checkpointReadError: "checkpoint_read_failed",
  };
  const ledger = createSupabasePlatformJobRunLedger(client, options);
  const calls = createManagedJobRunCalls(options);
  return { client, rpc, from, ledger, calls, releaseCorrelation, controls, runs };
}

type Fixture = ReturnType<typeof fixture>;
const claimSurfaces = [
  { name: "port", run: (f: Fixture) => f.ledger.claimJobRun("queue-drain", invocation) },
  { name: "v2", run: (f: Fixture) => f.calls.claimJobRun(f.client, "queue-drain", "pg_cron") },
  { name: "v3", run: (f: Fixture) => f.calls.claimJobRunV3(f.client, "queue-drain", invocation) },
];
const operations = [
  { name: "port claim", rpcName: "platform_claim_job_run", run: claimSurfaces[0]!.run },
  { name: "v2 claim", rpcName: "platform_claim_job_run", run: claimSurfaces[1]!.run },
  { name: "v3 claim", rpcName: "platform_claim_job_run_v3", run: claimSurfaces[2]!.run },
  {
    name: "port finish", rpcName: "platform_finish_job_run_v2",
    run: (f: Fixture) => f.ledger.finishJobRun("queue-drain", "run-8", invocation, "success", summary),
  },
  {
    name: "v2 finish", rpcName: "platform_finish_job_run_v2",
    run: (f: Fixture) => f.calls.finishJobRun(f.client, "queue-drain", "run-8", "success", summary),
  },
  {
    name: "v3 finish", rpcName: "platform_finish_job_run_v3",
    run: (f: Fixture) => f.calls.finishJobRunV3(f.client, "queue-drain", "run-8", "success", summary),
  },
];

describe("managed job-run ledger", () => {
  it.each(drivers)("maps %s to trigger %s and preserves both claim surfaces", async (driver, triggerKind, triggerSource, compatibilitySource) => {
    const f = fixture();
    f.rpc.mockResolvedValue({ data: [{ acquired: true, run_id: "run-8", reason: "acquired" }], error: null });
    expect(platformJobInvocationForDriver(driver)).toStrictEqual({ triggerKind, invocationSource: driver });
    await expect(f.ledger.claimJobRun("queue-drain", { triggerKind, invocationSource: ` ${driver} ` }, 120))
      .resolves.toStrictEqual({ acquired: true, runId: "run-8", reason: "acquired" });
    await expect(f.calls.claimJobRun(f.client, "queue-drain", driver, 120))
      .resolves.toStrictEqual({ acquired: true, runId: "run-8", reason: "acquired" });
    expect(f.rpc.mock.calls).toStrictEqual([
      ["platform_claim_job_run", {
        p_job_name: "queue-drain", p_driver: driver, p_lease_seconds: 120,
        p_metadata: { driver, triggerSource, ...release },
      }],
      ["platform_claim_job_run", {
        p_job_name: "queue-drain", p_driver: driver, p_lease_seconds: 120,
        p_metadata: { driver, triggerSource: compatibilitySource, ...release },
      }],
    ]);
    for (const [, args] of f.rpc.mock.calls) {
      expect(Object.keys(args)).toEqual(["p_job_name", "p_driver", "p_lease_seconds", "p_metadata"]);
      expect(Object.keys(args.p_metadata as object)).toEqual(["driver", "triggerSource", "releaseSha", "deploymentUrl"]);
    }
    expect(f.releaseCorrelation).toHaveBeenCalledTimes(2);
  });

  it("uses the v3 claim shape with a trimmed arbitrary source", async () => {
    const f = fixture();
    f.rpc.mockResolvedValue({ data: { acquired: true, run_id: "run-9", reason: "claimed" }, error: null });
    await expect(f.calls.claimJobRunV3(f.client, "nightly-report", {
      triggerKind: "worker", invocationSource: "  background-entry  ",
    }, 75)).resolves.toStrictEqual({ acquired: true, runId: "run-9", reason: "claimed" });
    expect(f.rpc.mock.calls).toStrictEqual([["platform_claim_job_run_v3", {
      p_job_name: "nightly-report", p_trigger_kind: "worker", p_invocation_source: "background-entry",
      p_lease_seconds: 75,
      p_metadata: { triggerKind: "worker", invocationSource: "background-entry", ...release },
    }]]);
    expect(Object.keys(f.rpc.mock.calls[0]![1])).toEqual([
      "p_job_name", "p_trigger_kind", "p_invocation_source", "p_lease_seconds", "p_metadata",
    ]);
    expect(Object.keys(f.rpc.mock.calls[0]![1].p_metadata as object)).toEqual([
      "triggerKind", "invocationSource", "releaseSha", "deploymentUrl",
    ]);
  });

  it.each(drivers)("finishes %s through the port with its invocation driver", async (driver, triggerKind) => {
    const f = fixture();
    await expect(f.ledger.finishJobRun("queue-drain", "run-8", {
      triggerKind, invocationSource: ` ${driver} `,
    }, "failed", summary, { driver: "extra-driver" })).resolves.toBe(true);
    expect(f.rpc.mock.calls).toStrictEqual([["platform_finish_job_run_v2", {
      p_job_name: "queue-drain", p_run_id: "run-8", p_status: "failed", p_checked: 6, p_updated: 2,
      p_error: "job_execution_failed", p_support_code: null,
      p_metadata: { failures: 1, skipped: false, reason: null, ...release, driver },
    }]]);
  });

  it.each(claimSurfaces)("defaults the $name claim lease to 900", async ({ run }) => {
    const f = fixture();
    await run(f);
    expect(f.rpc.mock.calls[0]![1].p_lease_seconds).toBe(900);
    expect(f.releaseCorrelation).toHaveBeenCalledExactlyOnceWith();
  });

  it.each([
    { triggerKind: "unknown", invocationSource: "worker", message: "platform_job_invalid_trigger_kind" },
    { triggerKind: "scheduler", invocationSource: "background-entry", message: "platform_job_invalid_invocation" },
    { triggerKind: "operator", invocationSource: "pg_cron", message: "platform_job_invalid_invocation" },
    { triggerKind: "worker", invocationSource: "manual_admin", message: "platform_job_invalid_invocation" },
    { triggerKind: "scheduler", invocationSource: "worker", message: "platform_job_invalid_invocation" },
    { triggerKind: "scheduler", invocationSource: "", message: "platform_job_invalid_invocation" },
    { triggerKind: "scheduler", invocationSource: " \t ", message: "platform_job_invalid_invocation" },
  ])("refuses unsupported port invocation $triggerKind/$invocationSource before side effects", async ({ triggerKind, invocationSource, message }) => {
    const f = fixture();
    const invalid = { triggerKind, invocationSource } as PlatformJobInvocation;
    await expect(f.ledger.claimJobRun("queue-drain", invalid)).rejects.toThrow(new Error(message));
    await expect(f.ledger.finishJobRun("queue-drain", "run-8", invalid, "failed", summary)).rejects.toThrow(new Error(message));
    expect(f.rpc).not.toHaveBeenCalled();
    expect(f.releaseCorrelation).not.toHaveBeenCalled();
    expect(f.from).not.toHaveBeenCalled();
  });

  it.each(["", " \t\n"])("refuses blank v3 source %j before side effects", async (invocationSource) => {
    const f = fixture();
    await expect(f.calls.claimJobRunV3(f.client, "queue-drain", { triggerKind: "scheduler", invocationSource }))
      .rejects.toThrow(new Error("platform_job_invocation_source_required"));
    expect(f.rpc).not.toHaveBeenCalled();
    expect(f.releaseCorrelation).not.toHaveBeenCalled();
  });

  it("gives release correlation precedence over claim metadata for both compatibility versions and the port", async () => {
    const f = fixture(() => ({
      driver: "release-driver", triggerSource: "release-source", triggerKind: "release-kind",
      invocationSource: "release-entry", revision: null,
    }));
    for (const { run } of claimSurfaces) await run(f);
    expect(f.rpc.mock.calls.map(([, args]) => args)).toStrictEqual([
      {
        p_job_name: "queue-drain", p_driver: "pg_cron", p_lease_seconds: 900,
        p_metadata: { driver: "release-driver", triggerSource: "release-source", triggerKind: "release-kind", invocationSource: "release-entry", revision: null },
      },
      {
        p_job_name: "queue-drain", p_driver: "pg_cron", p_lease_seconds: 900,
        p_metadata: { driver: "release-driver", triggerSource: "release-source", triggerKind: "release-kind", invocationSource: "release-entry", revision: null },
      },
      {
        p_job_name: "queue-drain", p_trigger_kind: "scheduler", p_invocation_source: "pg_cron", p_lease_seconds: 900,
        p_metadata: { triggerKind: "release-kind", invocationSource: "release-entry", driver: "release-driver", triggerSource: "release-source", revision: null },
      },
    ]);
    expect(Object.keys(f.rpc.mock.calls[2]![1].p_metadata as object)).toEqual([
      "triggerKind", "invocationSource", "driver", "triggerSource", "revision",
    ]);
  });

  it.each(operations)("reads fresh release correlation for each $name call", async ({ run }) => {
    const f = fixture();
    await run(f);
    f.releaseCorrelation.mockReturnValue({ releaseSha: "revision-8", deploymentUrl: null });
    await run(f);
    expect(f.rpc.mock.calls[0]![1].p_metadata).toMatchObject(release);
    expect(f.rpc.mock.calls[1]![1].p_metadata).toMatchObject({ releaseSha: "revision-8", deploymentUrl: null });
    expect(f.releaseCorrelation.mock.calls).toEqual([[], []]);
  });

  it("finishes through the port with exact v2 arguments and an authoritative invocation driver", async () => {
    const f = fixture();
    await expect(f.ledger.finishJobRun("nightly-report", "run-8", invocation, "failed", {
      ...summary, reason: "partial_failure",
    }, { checkpoint: "offset-9", driver: "extra-driver" })).resolves.toBe(true);
    expect(f.rpc.mock.calls).toStrictEqual([["platform_finish_job_run_v2", {
      p_job_name: "nightly-report", p_run_id: "run-8", p_status: "failed", p_checked: 6, p_updated: 2,
      p_error: "partial_failure", p_support_code: null,
      p_metadata: { failures: 1, skipped: false, reason: "partial_failure", ...release, checkpoint: "offset-9", driver: "pg_cron" },
    }]]);
    expect(Object.keys(f.rpc.mock.calls[0]![1])).toEqual(finishKeys);
    expect(Object.keys(f.rpc.mock.calls[0]![1].p_metadata as object)).toEqual([
      "failures", "skipped", "reason", "releaseSha", "deploymentUrl", "checkpoint", "driver",
    ]);
  });

  it("distinguishes v2 finish metadata and boolean from v3 metadata and void", async () => {
    const f = fixture();
    await expect(f.calls.finishJobRun(f.client, "queue-drain", "run-8", "success", summary)).resolves.toBe(true);
    await expect(f.calls.finishJobRunV3(f.client, "queue-drain", "run-8", "success", summary)).resolves.toBeUndefined();
    expect(f.rpc.mock.calls).toStrictEqual([
      ["platform_finish_job_run_v2", {
        p_job_name: "queue-drain", p_run_id: "run-8", p_status: "success", p_checked: 6, p_updated: 2,
        p_error: null, p_support_code: null,
        p_metadata: { driver: "manual_admin", failures: 1, skipped: false, reason: null, ...release },
      }],
      ["platform_finish_job_run_v3", {
        p_job_name: "queue-drain", p_run_id: "run-8", p_status: "success", p_checked: 6, p_updated: 2,
        p_error: null, p_support_code: null,
        p_metadata: { failures: 1, skipped: false, reason: null, ...release },
      }],
    ]);
    for (const [, args] of f.rpc.mock.calls) expect(Object.keys(args)).toEqual(finishKeys);
    expect(Object.keys(f.rpc.mock.calls[0]![1].p_metadata as object)).toEqual([
      "driver", "failures", "skipped", "reason", "releaseSha", "deploymentUrl",
    ]);
    expect(Object.keys(f.rpc.mock.calls[1]![1].p_metadata as object)).toEqual([
      "failures", "skipped", "reason", "releaseSha", "deploymentUrl",
    ]);
  });

  it("merges summary then correlation then extra metadata, with the port driver last", async () => {
    const f = fixture(() => ({
      releaseSha: "revision-7", deploymentUrl: null, driver: "release-driver",
      failures: "release-failures", skipped: "release-skipped", reason: "release-reason",
    }));
    const extra = { releaseSha: "extra-revision", driver: "extra-driver", failures: 9, skipped: true, reason: "extra-reason", checkpoint: "offset-4" };
    await f.calls.finishJobRun(f.client, "queue-drain", "run-8", "failed", summary);
    await f.calls.finishJobRunV3(f.client, "queue-drain", "run-8", "failed", summary);
    await f.ledger.finishJobRun("queue-drain", "run-8", invocation, "failed", summary);
    await f.calls.finishJobRun(f.client, "queue-drain", "run-8", "failed", summary, extra);
    await f.calls.finishJobRunV3(f.client, "queue-drain", "run-8", "failed", summary, extra);
    await f.ledger.finishJobRun("queue-drain", "run-8", invocation, "failed", summary, extra);
    const correlated = {
      releaseSha: "revision-7", deploymentUrl: null, driver: "release-driver",
      failures: "release-failures", skipped: "release-skipped", reason: "release-reason",
    };
    expect(f.rpc.mock.calls.map(([, args]) => args.p_metadata)).toStrictEqual([
      correlated, correlated, { ...correlated, driver: "pg_cron" },
      { ...correlated, ...extra }, { ...correlated, ...extra }, { ...correlated, ...extra, driver: "pg_cron" },
    ]);
    for (const [, args] of f.rpc.mock.calls) expect(args.p_error).toBe("job_execution_failed");
    expect(extra.driver).toBe("extra-driver");
  });

  it.each([
    ["failed", undefined, "job_execution_failed"],
    ["failed", "explicit_failure", "explicit_failure"],
    ["failed", "", ""],
    ["success", undefined, null],
    ["success", "observed_reason", null],
  ] as const)("uses the failure fallback only for %s with reason %j", async (status, reason, error) => {
    const f = fixture();
    const result = { ...summary, skipped: true, ...(reason === undefined ? {} : { reason }) };
    await f.calls.finishJobRun(f.client, "queue-drain", "run-8", status, result);
    await f.calls.finishJobRunV3(f.client, "queue-drain", "run-8", status, result);
    await f.ledger.finishJobRun("queue-drain", "run-8", invocation, status, result);
    expect(f.rpc.mock.calls.map(([, args]) => ({
      status: args.p_status, error: args.p_error, metadata: args.p_metadata,
    }))).toStrictEqual([
      { status, error, metadata: { driver: "manual_admin", failures: 1, skipped: true, reason: reason ?? null, ...release } },
      { status, error, metadata: { failures: 1, skipped: true, reason: reason ?? null, ...release } },
      { status, error, metadata: { failures: 1, skipped: true, reason: reason ?? null, ...release, driver: "pg_cron" } },
    ]);
  });

  describe.each(claimSurfaces)("$name claim parsing", ({ run }) => {
    it.each([
      { data: { acquired: true, run_id: "run-8", reason: "claimed" }, expected: { acquired: true, runId: "run-8", reason: "claimed" } },
      { data: [{ acquired: true, run_id: "run-8", reason: "claimed" }, { acquired: false }], expected: { acquired: true, runId: "run-8", reason: "claimed" } },
      { data: [{ acquired: false, run_id: "run-older", reason: "lease_active" }], expected: { acquired: false, runId: "run-older", reason: "lease_active" } },
      { data: { acquired: true, run_id: "", reason: "" }, expected: { acquired: true, runId: "", reason: "" } },
      { data: { acquired: "true", run_id: 8, reason: false }, expected: { acquired: false, runId: null, reason: "unknown" } },
    ])("parses $data", async ({ data, expected }) => {
      const f = fixture();
      f.rpc.mockResolvedValue({ data, error: null });
      await expect(run(f)).resolves.toStrictEqual(expected);
    });

    it.each([undefined, null, [], [null], [[]], "row", 7, false, {}].map((data) => ({ data })))(
      "defaults malformed or absent result $data", async ({ data }) => {
        const f = fixture();
        f.rpc.mockResolvedValue({ data, error: null });
        await expect(run(f)).resolves.toStrictEqual({ acquired: false, runId: null, reason: "unknown" });
      },
    );
  });

  it.each([true, false, null, undefined, "true", 1, { released: true }, [true]])(
    "returns true only for a literal true v2 finish result %j", async (data) => {
      const f = fixture();
      f.rpc.mockResolvedValue({ data, error: null });
      await expect(f.calls.finishJobRun(f.client, "queue-drain", "run-8", "success", summary)).resolves.toBe(data === true);
      await expect(f.ledger.finishJobRun("queue-drain", "run-8", invocation, "success", summary)).resolves.toBe(data === true);
      await expect(f.calls.finishJobRunV3(f.client, "queue-drain", "run-8", "success", summary)).resolves.toBeUndefined();
    },
  );

  describe.each(operations)("$name RPC failures", ({ run, rpcName }) => {
    it.each(["rpc_unavailable", "", undefined])("uses message %j with an RPC-specific fallback", async (message) => {
      const f = fixture();
      f.rpc.mockResolvedValue({ data: true, error: message === undefined ? {} : { message } });
      await expect(run(f)).rejects.toThrow(new Error(message ?? `${rpcName} failed`));
      expect(f.rpc).toHaveBeenCalledTimes(1);
      expect(f.rpc.mock.calls[0]![0]).toBe(rpcName);
    });

    it("propagates a rejected client promise unchanged", async () => {
      const f = fixture();
      const failure = new Error("transport_failed");
      f.rpc.mockRejectedValue(failure);
      await expect(run(f)).rejects.toBe(failure);
    });
  });

  it("reads backstop state with the exact control query", async () => {
    const f = fixture();
    f.controls.chain.maybeSingle.mockResolvedValue({ data: { last_status: "success", last_success_at: "2032-04-05T06:07:08Z" }, error: null });
    await expect(f.ledger.readJobBackstopState("nightly-report")).resolves.toStrictEqual({
      lastStatus: "success", lastSuccessAt: "2032-04-05T06:07:08Z",
    });
    expect(f.from.mock.calls).toEqual([["platform_job_controls"]]);
    expect(f.controls.trace).toEqual([
      ["select", "last_status,last_success_at"], ["eq", "job_name", "nightly-report"],
    ]);
    expect(f.controls.chain.maybeSingle).toHaveBeenCalledExactlyOnceWith();
    expect(f.controls.chain.eq.mock.invocationCallOrder[0])
      .toBeLessThan(f.controls.chain.maybeSingle.mock.invocationCallOrder[0]!);
    expect(f.rpc).not.toHaveBeenCalled();
    expect(f.releaseCorrelation).not.toHaveBeenCalled();
  });

  it.each([
    { data: null, expected: null },
    { data: {}, expected: { lastStatus: null, lastSuccessAt: null } },
    { data: { last_status: null, last_success_at: null }, expected: { lastStatus: null, lastSuccessAt: null } },
    { data: { last_status: "failed" }, expected: { lastStatus: "failed", lastSuccessAt: null } },
    { data: { last_success_at: "" }, expected: { lastStatus: null, lastSuccessAt: "" } },
  ])("normalizes absent backstop fields in $data", async ({ data, expected }) => {
    const f = fixture();
    f.controls.chain.maybeSingle.mockResolvedValue({ data, error: null });
    await expect(f.ledger.readJobBackstopState("nightly-report")).resolves.toStrictEqual(expected);
  });

  it("reads a copy of the latest terminal metadata with exact query order", async () => {
    const f = fixture();
    const metadata = { checkpoint: "offset-11", nested: { count: 2 } };
    f.runs.chain.maybeSingle.mockResolvedValue({ data: { metadata }, error: null });
    const result = await f.ledger.readLatestTerminalRunMetadata("nightly-report");
    expect(result).toStrictEqual(metadata);
    expect(result).not.toBe(metadata);
    expect(f.from.mock.calls).toEqual([["platform_job_runs"]]);
    expect(f.runs.trace).toEqual([
      ["select", "metadata"], ["eq", "job_name", "nightly-report"], ["in", "status", ["success", "failed"]],
      ["order", "started_at", { ascending: false }], ["limit", 1],
    ]);
    expect(f.runs.chain.maybeSingle).toHaveBeenCalledExactlyOnceWith();
    expect(f.runs.chain.limit.mock.invocationCallOrder[0])
      .toBeLessThan(f.runs.chain.maybeSingle.mock.invocationCallOrder[0]!);
    expect(f.rpc).not.toHaveBeenCalled();
    expect(f.releaseCorrelation).not.toHaveBeenCalled();
  });

  it.each([null, {}, { metadata: null }, { metadata: [] }, { metadata: "offset-11" }, { metadata: 4 }])(
    "returns null for missing or non-record checkpoint metadata %j", async (data) => {
      const f = fixture();
      f.runs.chain.maybeSingle.mockResolvedValue({ data, error: null });
      await expect(f.ledger.readLatestTerminalRunMetadata("nightly-report")).resolves.toBeNull();
    },
  );

  it("preserves an empty metadata record", async () => {
    const f = fixture();
    f.runs.chain.maybeSingle.mockResolvedValue({ data: { metadata: {} }, error: null });
    await expect(f.ledger.readLatestTerminalRunMetadata("nightly-report")).resolves.toStrictEqual({});
  });

  it.each(["backstop", "checkpoint"] as const)("uses the injected %s failure message and propagates rejected reads", async (kind) => {
    const f = fixture();
    const chain = kind === "backstop" ? f.controls.chain : f.runs.chain;
    const read = () => kind === "backstop"
      ? f.ledger.readJobBackstopState("nightly-report")
      : f.ledger.readLatestTerminalRunMetadata("nightly-report");
    chain.maybeSingle.mockResolvedValue({ data: { metadata: { checkpoint: "offset-11" } }, error: { message: "upstream_detail" } });
    await expect(read()).rejects.toThrow(new Error(`${kind}_read_failed`));
    chain.maybeSingle.mockResolvedValue({ data: null, error: {} });
    await expect(read()).rejects.toThrow(new Error(`${kind}_read_failed`));
    const failure = new Error("read_transport_failed");
    chain.maybeSingle.mockRejectedValue(failure);
    await expect(read()).rejects.toBe(failure);
  });
});
