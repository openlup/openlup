import { describe, expect, it } from "vitest";
import {
  localRenewalRunCleanupSql,
  recoverReferenceRenewalLease,
  REFERENCE_RENEWAL_JOB_NAME,
  withReferenceRenewalLeaseFixture,
  type ReferenceRenewalLeaseManifest,
} from "./reference-renewal-lease-fixture.ts";

type Row = Record<string, unknown>;
const DB_URL = "postgresql://postgres:postgres@127.0.0.1:54322/postgres";
const PREEXISTING_ID = "11111111-1111-4111-8111-111111111111";
const CREATED_ID = "22222222-2222-4222-8222-222222222222";

function initialControl(): Row {
  return {
    job_name: REFERENCE_RENEWAL_JOB_NAME,
    created_at: "2026-07-01T00:00:00.000Z",
    updated_at: "2026-07-01T00:00:00.000Z",
    enabled: false,
    active_driver: "manual_admin",
    allowed_trigger_kinds: null,
    lease_owner: null,
    lease_token: null,
    lease_until: null,
    lease_expires_at: null,
    last_started_at: null,
    last_finished_at: null,
    last_success_at: null,
    last_status: null,
    last_run_id: null,
    metadata: { owner: "commerce/subscriptions" },
  };
}

function fakeClient(state: { control: Row; runs: Row[] }) {
  return {
    from(table: string) {
      let action: "select" | "update" = "select";
      let update: Row = {};
      const filters: Array<[string, string]> = [];
      const query = {
        select() { action = "select"; return query; },
        update(values: Row) { action = "update"; update = values; return query; },
        eq(column: string, value: string) { filters.push([column, value]); return query; },
        then(resolve: (value: unknown) => unknown, reject: (reason: unknown) => unknown) {
          try {
            if (table === "platform_job_controls") {
              if (action === "update") Object.assign(state.control, update);
              const data = filters.every(([column, value]) => state.control[column] === value) ? [{ ...state.control }] : [];
              return Promise.resolve({ data, error: null }).then(resolve, reject);
            }
            const data = state.runs.filter((row) => filters.every(([column, value]) => row[column] === value)).map((row) => ({ ...row }));
            return Promise.resolve({ data, error: null }).then(resolve, reject);
          } catch (error) {
            return Promise.reject(error).then(resolve, reject);
          }
        },
      };
      return query;
    },
  };
}

function addRun(state: { control: Row; runs: Row[] }, status: "success" | "failed"): void {
  state.runs.push({ id: CREATED_ID, job_name: REFERENCE_RENEWAL_JOB_NAME, status, driver: "manual_admin", trigger_source: "manual_admin", error: status === "failed" ? "fixture_failed" : null });
  Object.assign(state.control, { enabled: true, updated_at: "2026-07-30T00:00:00.000Z", last_status: status, last_run_id: CREATED_ID });
}

function cleanupRunner(state: { control: Row; runs: Row[] }, original: Row, sqlLog: string[]) {
  return (_command: string, args: string[]) => {
    const sql = args.at(-1) ?? "";
    sqlLog.push(sql);
    state.runs = state.runs.filter((row) => row.id !== CREATED_ID);
    for (const key of Object.keys(state.control)) delete state.control[key];
    Object.assign(state.control, original);
    return { status: 0 };
  };
}

describe("reference renewal lease fixture", () => {
  it("proves one manual_admin run, restores the control, and deletes only the new id", async () => {
    const original = initialControl();
    const state = { control: { ...original }, runs: [{ id: PREEXISTING_ID, job_name: REFERENCE_RENEWAL_JOB_NAME, status: "success", driver: "worker", trigger_source: "worker", error: null }] };
    const manifest: { referenceRenewalLease?: ReferenceRenewalLeaseManifest } = {};
    const sqlLog: string[] = [];
    const result = await withReferenceRenewalLeaseFixture({
      client: fakeClient(state) as never,
      dbUrl: DB_URL,
      manifest,
      persistManifest: () => undefined,
      run: async () => { addRun(state, "success"); return "tick-ok"; },
      psql: "psql",
      runPsql: cleanupRunner(state, original, sqlLog),
    });

    expect(result).toEqual({ value: "tick-ok", evidence: { jobName: REFERENCE_RENEWAL_JOB_NAME, driver: "manual_admin", status: "success", createdRows: 1, deletedRows: 1, residualRows: 0, controlRestored: true } });
    expect(state.control).toEqual(original);
    expect(state.runs.map((row) => row.id)).toEqual([PREEXISTING_ID]);
    expect(manifest.referenceRenewalLease).toBeUndefined();
    expect(sqlLog[0]).toContain(CREATED_ID);
    expect(sqlLog[0]).not.toContain(PREEXISTING_ID);
  });

  it("restores and deletes the exact run when the wrapped renewal fails", async () => {
    const original = initialControl();
    const state = { control: { ...original }, runs: [] as Row[] };
    const manifest: { referenceRenewalLease?: ReferenceRenewalLeaseManifest } = {};

    await expect(withReferenceRenewalLeaseFixture({
      client: fakeClient(state) as never,
      dbUrl: DB_URL,
      manifest,
      persistManifest: () => undefined,
      run: async () => { addRun(state, "failed"); throw new Error("tick failed"); },
      psql: "psql",
      runPsql: cleanupRunner(state, original, []),
    })).rejects.toThrow("tick failed");
    expect(state.control).toEqual(original);
    expect(state.runs).toEqual([]);
    expect(manifest.referenceRenewalLease).toBeUndefined();
  });

  it("builds an exact job-and-id-bounded cleanup transaction", () => {
    const sql = localRenewalRunCleanupSql(CREATED_ID, initialControl());
    expect(sql).toContain(`job_name = '${REFERENCE_RENEWAL_JOB_NAME}'`);
    expect(sql).toContain(`'${CREATED_ID}'::uuid`);
    expect(sql).not.toContain("LIKE");
    expect(() => localRenewalRunCleanupSql("not-a-uuid", initialControl())).toThrow("exact correlated");
    expect(() => localRenewalRunCleanupSql(CREATED_ID, { job_name: "other" })).toThrow("exact correlated");
  });

  it("recovers the correlated run while preserving an older run", async () => {
    const original = { ...initialControl(), last_run_id: PREEXISTING_ID, last_status: "success" };
    const state = {
      control: { ...original, enabled: true, last_run_id: CREATED_ID, last_status: "success" },
      runs: [
        { id: PREEXISTING_ID, job_name: REFERENCE_RENEWAL_JOB_NAME, status: "success", driver: "worker", trigger_source: "worker", error: null },
        { id: CREATED_ID, job_name: REFERENCE_RENEWAL_JOB_NAME, status: "success", driver: "manual_admin", trigger_source: "manual_admin", error: null },
      ],
    };
    await recoverReferenceRenewalLease(fakeClient(state) as never, DB_URL, { version: 1, jobName: REFERENCE_RENEWAL_JOB_NAME, control: original }, {
      psql: "psql",
      runPsql: cleanupRunner(state, original, []),
    });
    expect(state.control).toEqual(original);
    expect(state.runs.map((row) => row.id)).toEqual([PREEXISTING_ID]);
  });
});
