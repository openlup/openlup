import { describe, expect, it, vi } from "vitest";
import type { JobLeasePort } from "@openlup/core/platform-runtime";

import { authorizeCron } from "../../src/scheduler/cronGuard.js";
import { createScheduledJobHttpEntry } from "../../src/scheduler/httpEntry.js";
import type { ScheduledJob } from "../../src/scheduler/jobs.js";
import type { HttpRequest, HttpResponse } from "../../src/http/types.js";

const env = { CRON_SECRET: "cron-secret" };
const summary = { checked: 1, updated: 1, failures: 0, skipped: false };

function request(authorization?: string, method = "GET") {
  return { method, headers: authorization ? { authorization } : {} } as unknown as HttpRequest;
}

function response() {
  const sent: { status?: number; body?: unknown } = {};
  const res = {
    status: vi.fn((code: number) => { sent.status = code; return res; }),
    json: vi.fn((body: unknown) => { sent.body = body; return res; }),
  } as unknown as HttpResponse;
  return { res, sent };
}

function job(run: ScheduledJob["run"] = vi.fn(async () => summary), lease?: ScheduledJob["lease"]): ScheduledJob {
  return { id: "nightly-report", schedule: "0 2 * * *", lease, run };
}

describe("scheduled job HTTP entry", () => {
  it.each([
    ["wrong method", request("Bearer cron-secret", "PUT"), env],
    ["missing secret", request("Bearer cron-secret"), { CRON_SECRET: "" }],
    ["wrong token", request("Bearer other-secret"), env],
    ["no token", request(), env],
  ])("answers the cron guard's exact refusal for %s without running", async (_name, req, configured) => {
    const target = job();
    const { res, sent } = response();
    await createScheduledJobHttpEntry(target, { env: () => configured, invocationSource: "hosted_cron" })(req, res);
    const guard = authorizeCron(req, configured)!;
    expect(sent).toEqual({ status: guard.status, body: guard.body });
    expect(JSON.stringify(sent.body)).toBe(JSON.stringify(guard.body));
    expect(target.run).not.toHaveBeenCalled();
  });

  it("runs an authorized request with the HTTP invocation and answers its summary", async () => {
    const target = job();
    const { res, sent } = response();
    await createScheduledJobHttpEntry(target, { env: () => env, invocationSource: "hosted_cron" })(request("Bearer cron-secret", "POST"), res);
    expect(target.run).toHaveBeenCalledExactlyOnceWith({ invocation: { triggerKind: "scheduler", invocationSource: "hosted_cron" }, signal: undefined });
    expect(sent).toEqual({ status: 200, body: { ok: true, result: summary } });
  });

  it("answers skipped without running when the lease is held elsewhere", async () => {
    const lease = {
      claimJobRun: vi.fn<JobLeasePort["claimJobRun"]>(async () => ({ acquired: false, runId: null, reason: "lease_held" })),
      finishJobRun: vi.fn<JobLeasePort["finishJobRun"]>(async () => true),
    };
    const target = job(vi.fn(async () => summary), { seconds: 60 });
    const { res, sent } = response();
    await createScheduledJobHttpEntry(target, { env: () => env, invocationSource: "hosted_cron", lease })(request("Bearer cron-secret"), res);
    expect(sent).toEqual({ status: 200, body: { ok: true, skipped: true, reason: "lease_held" } });
    expect(target.run).not.toHaveBeenCalled();
  });

  it("answers 500 without error detail and hands the error to the sink", async () => {
    const failure = new Error("sensitive internal detail");
    const onError = vi.fn();
    const { res, sent } = response();
    await createScheduledJobHttpEntry(job(async () => { throw failure; }), { env: () => env, invocationSource: "hosted_cron", onError })(request("Bearer cron-secret"), res);
    expect(sent).toEqual({ status: 500, body: { ok: false, error: "scheduled_job_failed" } });
    expect(JSON.stringify(sent.body)).not.toContain("sensitive");
    expect(onError).toHaveBeenCalledExactlyOnceWith("nightly-report", failure);
  });

  it("reads the configured secret on every request", async () => {
    let configured = { CRON_SECRET: "first-secret" };
    const entry = createScheduledJobHttpEntry(job(), { env: () => configured, invocationSource: "hosted_cron" });
    const first = response();
    await entry(request("Bearer first-secret"), first.res);
    configured = { CRON_SECRET: "second-secret" };
    const second = response();
    await entry(request("Bearer first-secret"), second.res);
    expect([first.sent.status, second.sent.status]).toEqual([200, 401]);
  });
});
