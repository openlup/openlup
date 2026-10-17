import { describe, expect, it, vi } from "vitest";
import type { JobLeasePort } from "@openlup/core/platform-runtime";

import {
  createScheduledJobRegistry,
  cronFromCadenceSeconds,
  runScheduledJob,
  scheduledJobsFromContribution,
  type ScheduledJob,
} from "../../src/scheduler/jobs.js";

const invocation = { triggerKind: "scheduler", invocationSource: "node_cron" } as const;
const summary = { checked: 3, updated: 2, failures: 0, skipped: false };

function lease(claim: Awaited<ReturnType<JobLeasePort["claimJobRun"]>> = { acquired: true, runId: "run-1", reason: "acquired" }) {
  return {
    claimJobRun: vi.fn<JobLeasePort["claimJobRun"]>(async () => claim),
    finishJobRun: vi.fn<JobLeasePort["finishJobRun"]>(async () => true),
  };
}

function job(overrides: Partial<ScheduledJob> = {}): ScheduledJob {
  return { id: "nightly-report", schedule: "0 2 * * *", run: vi.fn(async () => summary), ...overrides };
}

describe("scheduled job registry", () => {
  it("merges contributions in order and refuses duplicates and empty ids or schedules", () => {
    const first = job({ id: "a" });
    const second = job({ id: "b" });
    expect(createScheduledJobRegistry([first], [second]).map(({ id }) => id)).toEqual(["a", "b"]);
    expect(createScheduledJobRegistry()).toEqual([]);
    expect(() => createScheduledJobRegistry([first], [job({ id: "a" })])).toThrow("scheduled_job_duplicate:a");
    expect(() => createScheduledJobRegistry([job({ id: " " })])).toThrow("scheduled_job_id_required");
    expect(() => createScheduledJobRegistry([job({ id: "c", schedule: "" })])).toThrow("scheduled_job_schedule_required:c");
    expect(Object.isFrozen(createScheduledJobRegistry([first]))).toBe(true);
  });
});

describe("cadence adaptation", () => {
  it.each([
    [60, "* * * * *"], [300, "*/5 * * * *"], [900, "*/15 * * * *"], [1800, "*/30 * * * *"],
    [3600, "0 * * * *"], [7200, "0 */2 * * *"], [21600, "0 */6 * * *"], [86400, "0 0 * * *"],
  ])("maps %i seconds exactly to %s", (seconds, cron) => {
    expect(cronFromCadenceSeconds(seconds)).toBe(cron);
  });

  it.each([0, -60, 30, 90, 420, 2700, 5400, 18000, 172800, 60.5])("refuses the non-dividing or inexact cadence %s", (seconds) => {
    expect(() => cronFromCadenceSeconds(seconds)).toThrow(`scheduled_job_cadence_unsupported:${seconds}`);
  });

  it("adapts a contribution schedule and passes the invocation through", async () => {
    const run = vi.fn(async () => "ignored");
    const [adapted] = scheduledJobsFromContribution([{ id: "queue-drain", cadenceSeconds: 60, run }]);
    expect(adapted).toMatchObject({ id: "queue-drain", schedule: "* * * * *" });
    expect(adapted!.lease).toBeUndefined();
    await expect(runScheduledJob(adapted!, { invocation })).resolves.toEqual({ status: "completed", summary: null });
    expect(run).toHaveBeenCalledExactlyOnceWith(invocation);
    expect(() => scheduledJobsFromContribution([{ id: "odd", cadenceSeconds: 420, run }])).toThrow("scheduled_job_cadence_unsupported:420");
  });

  it("fails the job when the contribution reports a failed outcome without throwing", async () => {
    const [failed] = scheduledJobsFromContribution([
      { id: "queue-drain", cadenceSeconds: 60, run: async () => ({ outcome: "failed", detail: { failures: 1 } }) },
    ]);
    await expect(runScheduledJob(failed!, { invocation })).rejects.toThrow("scheduled_job_outcome_failed:queue-drain");
    for (const outcome of ["success", "skipped"]) {
      const [settled] = scheduledJobsFromContribution([{ id: "queue-drain", cadenceSeconds: 60, run: async () => ({ outcome }) }]);
      await expect(runScheduledJob(settled!, { invocation })).resolves.toEqual({ status: "completed", summary: null });
    }
  });
});

describe("running a job", () => {
  it("runs a lease-free job directly with its invocation", async () => {
    const target = job();
    await expect(runScheduledJob(target, { invocation })).resolves.toEqual({ status: "completed", summary });
    expect(target.run).toHaveBeenCalledExactlyOnceWith({ invocation, signal: undefined });
  });

  it("claims, runs with the run id, and finishes success with the job's summary", async () => {
    const port = lease();
    const target = job({ lease: { seconds: 120 } });
    await expect(runScheduledJob(target, { invocation, lease: port })).resolves.toEqual({ status: "completed", summary });
    expect(port.claimJobRun).toHaveBeenCalledExactlyOnceWith("nightly-report", invocation, 120);
    expect(target.run).toHaveBeenCalledExactlyOnceWith({ invocation, runId: "run-1", signal: undefined });
    expect(port.finishJobRun).toHaveBeenCalledExactlyOnceWith("nightly-report", "run-1", invocation, "success", summary);
  });

  it("refuses to report completion when the lease refuses the finish", async () => {
    const port = lease();
    port.finishJobRun.mockResolvedValueOnce(false);
    const target = job({ lease: { seconds: 120 } });
    await expect(runScheduledJob(target, { invocation, lease: port })).rejects.toThrow("scheduled_job_finish_refused:nightly-report");
    expect(target.run).toHaveBeenCalledOnce();
    expect(port.finishJobRun).toHaveBeenCalledExactlyOnceWith("nightly-report", "run-1", invocation, "success", summary);
  });

  it("skips without calling run when the lease is held elsewhere", async () => {
    const port = lease({ acquired: false, runId: null, reason: "lease_held" });
    const target = job({ lease: { seconds: 120 } });
    await expect(runScheduledJob(target, { invocation, lease: port })).resolves.toEqual({ status: "skipped", reason: "lease_held" });
    expect(target.run).not.toHaveBeenCalled();
    expect(port.finishJobRun).not.toHaveBeenCalled();
  });

  it("finishes failed and rethrows the job's error", async () => {
    const port = lease();
    const failure = new Error("job_broke");
    const target = job({ lease: { seconds: 60 }, run: vi.fn(async () => { throw failure; }) });
    await expect(runScheduledJob(target, { invocation, lease: port })).rejects.toBe(failure);
    expect(port.finishJobRun).toHaveBeenCalledExactlyOnceWith("nightly-report", "run-1", invocation, "failed", {
      checked: 0, updated: 0, failures: 1, skipped: false,
    });
  });

  it("reports both errors when the failed run cannot be finished", async () => {
    const port = lease();
    port.finishJobRun.mockRejectedValueOnce(new Error("finish_broke"));
    const target = job({ lease: { seconds: 60 }, run: vi.fn(async () => { throw new Error("job_broke"); }) });
    await expect(runScheduledJob(target, { invocation, lease: port })).rejects.toMatchObject({
      message: "scheduled_job_failed_unfinished:nightly-report",
      errors: [expect.objectContaining({ message: "job_broke" }), expect.objectContaining({ message: "finish_broke" })],
    });
  });

  it("finishes success with an empty summary when the job returns none, and refuses a missing port or run id", async () => {
    const port = lease();
    await runScheduledJob(job({ lease: { seconds: 60 }, run: async () => undefined }), { invocation, lease: port });
    expect(port.finishJobRun).toHaveBeenCalledWith("nightly-report", "run-1", invocation, "success", {
      checked: 0, updated: 0, failures: 0, skipped: false,
    });
    await expect(runScheduledJob(job({ lease: { seconds: 60 } }), { invocation }))
      .rejects.toThrow("scheduled_job_lease_port_required:nightly-report");
    await expect(runScheduledJob(job({ lease: { seconds: 60 } }), { invocation, lease: lease({ acquired: true, runId: null, reason: "acquired" }) }))
      .rejects.toThrow("scheduled_job_lease_without_run_id:nightly-report");
  });
});
