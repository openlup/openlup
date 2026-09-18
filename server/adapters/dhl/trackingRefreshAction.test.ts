import { describe, expect, it, vi } from "vitest";
import {
  TRACKING_BATCH_SIZE,
  TRACKING_FAILURE_CODE,
  TRACKING_SUPPORT_PREFIX,
  createTrackingRefreshAction,
  type CarrierTrackingClient,
} from "./trackingRefreshAction.js";
import { SCHEDULED_CRON_DRIVER, TRACKING_JOB_NAME } from "./trackingJobLedger.js";

describe("tracking refresh action", () => {
  it("keeps scheduler authentication and manual-admin anti-spoofing", async () => {
    const unauthorized = trackingFixture();
    await expect(unauthorized.action(new Request("https://example.test", { method: "POST" })).then((response) => response.json()))
      .resolves.toEqual({ error: "Unauthorized" });
    expect(unauthorized.rpc).not.toHaveBeenCalledWith("platform_claim_job_run", expect.anything());

    const cron = trackingFixture();
    const response = await cron.action(request({ driver: "manual_admin", triggerSource: "admin:spoofed" }));
    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toEqual({ error: "manual_admin requires admin auth" });

    const invalid = trackingFixture();
    const invalidResponse = await invalid.action(request({ driver: "untrusted_cron" }));
    expect(invalidResponse.status).toBe(400);
    await expect(invalidResponse.json()).resolves.toEqual({ error: "Invalid scheduler driver" });
  });

  it("records schedule metadata from the generic body, not a provider header", async () => {
    const fixture = trackingFixture();
    await fixture.action(request({
      cronSchedule: "0 * * * *",
      providerCronSchedule: "spoofed-provider-header",
    }));

    expect(fixture.rpc).toHaveBeenNthCalledWith(1, "platform_claim_job_run", expect.objectContaining({
      p_metadata: expect.objectContaining({ cronSchedule: "0 * * * *" }),
    }));
    expect(fixture.rpc.mock.calls[0]?.[1]).not.toEqual(expect.objectContaining({
      p_metadata: expect.objectContaining({ cronSchedule: "spoofed-provider-header" }),
    }));
  });

  it("uses the canonical status mapper, updates diagnostics, emails, and finishes the lease", async () => {
    const fixture = trackingFixture({ xml: "<status>DWP</status><description>w drodze</description>" });
    const response = await fixture.action(request());

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      success: true, driver: SCHEDULED_CRON_DRIVER, checked: 1, updated: 1, batch_size: TRACKING_BATCH_SIZE,
      results: [{ tester_id: "tester-1", old_status: "shipped", new_status: "in_transit", codes: ["DWP"] }],
    });
    expect(fixture.update).toHaveBeenNthCalledWith(1, expect.objectContaining({
      dhl_last_codes: ["DWP"], dhl_last_descriptions: ["w drodze"],
    }));
    expect(fixture.statusUpdate).toHaveBeenCalledWith(expect.objectContaining({ status: "in_transit" }));
    expect(fixture.sendEmail).toHaveBeenCalledWith("tester-1", "in-transit", TRACKING_JOB_NAME);
    expect(fixture.rpc).toHaveBeenNthCalledWith(1, "platform_claim_job_run", expect.objectContaining({
      p_job_name: TRACKING_JOB_NAME, p_driver: SCHEDULED_CRON_DRIVER, p_lease_seconds: 1200,
    }));
    expect(fixture.rpc).toHaveBeenNthCalledWith(2, "platform_finish_job_run_v2", expect.objectContaining({
      p_status: "success", p_checked: 1, p_updated: 1,
    }));
  });

  it("uses the canonical delivered mapping and retains delivered_at semantics", async () => {
    const fixture = trackingFixture({ xml: "<status>DOR</status><description>doręczono</description>" });
    const response = await fixture.action(request());

    await expect(response.json()).resolves.toMatchObject({
      updated: 1,
      results: [{ new_status: "delivered", codes: ["DOR"] }],
    });
    expect(fixture.statusUpdate).toHaveBeenCalledWith(expect.objectContaining({
      status: "delivered",
      delivered_at: "2030-01-01T00:00:00.000Z",
    }));
    expect(fixture.sendEmail).toHaveBeenCalledWith("tester-1", "delivered", TRACKING_JOB_NAME);
  });

  it("returns the existing all-provider-failures response and ledger support code", async () => {
    const fixture = trackingFixture({ xml: "<faultstring>carrier unavailable</faultstring>" });
    const response = await fixture.action(request());

    expect(response.status).toBe(502);
    await expect(response.json()).resolves.toMatchObject({
      error: TRACKING_FAILURE_CODE, success: false, checked: 1, updated: 0,
      support_code: expect.stringMatching(new RegExp(`^${TRACKING_SUPPORT_PREFIX}`)),
    });
    expect(fixture.rpc).toHaveBeenLastCalledWith("platform_finish_job_run_v2", expect.objectContaining({
      p_status: "failed", p_error: TRACKING_FAILURE_CODE, p_support_code: expect.stringMatching(new RegExp(`^${TRACKING_SUPPORT_PREFIX}`)),
    }));
    expect(fixture.update).toHaveBeenCalledWith(expect.objectContaining({
      dhl_last_codes: [], dhl_last_descriptions: [],
    }));
    expect(fixture.sendEmail).not.toHaveBeenCalled();
  });

  it("skips an already-held lease without carrier egress", async () => {
    const fixture = trackingFixture({ lease: { acquired: false, run_id: "held-run", reason: "already_running", lease_until: "2030-01-01T00:20:00Z" } });
    await expect(fixture.action(request()).then((response) => response.json())).resolves.toMatchObject({
      success: true, skipped: true, reason: "already_running", run_id: "held-run", checked: 0, updated: 0,
    });
    expect(fixture.fetchImpl).not.toHaveBeenCalled();
    expect(fixture.finish).not.toHaveBeenCalled();
  });

  it("finishes a failed lease when tester loading fails", async () => {
    const fixture = trackingFixture({ testerLoadError: { message: "db unavailable" } });
    const response = await fixture.action(request());
    expect(response.status).toBe(500);
    await expect(response.json()).resolves.toEqual({ error: "Failed to fetch testers" });
    expect(fixture.finish).toHaveBeenCalledWith(expect.objectContaining({
      p_status: "failed", p_checked: null, p_updated: null, p_error: "Failed to fetch testers",
    }));
  });

  it("keeps batch, time admission, and provider diagnostics parity", async () => {
    const testers = [tester("tester-1"), tester("tester-2")];
    const fixture = trackingFixture({ testers, now: sequenceNow([0, 45_000, 45_000]) });
    await expect(fixture.action(request()).then((response) => response.json())).resolves.toMatchObject({
      checked: 0, remaining: 2, batch_size: 60, results: [],
    });
    expect(fixture.limit).toHaveBeenCalledWith(60);
    expect(fixture.fetchImpl).not.toHaveBeenCalled();

    const oversized = "<status>DWP</status>".padEnd(8_200, "x");
    const diagnostic = trackingFixture({ xml: oversized });
    await diagnostic.action(request());
    expect(diagnostic.update).toHaveBeenNthCalledWith(1, expect.objectContaining({
      dhl_last_response: `${oversized.slice(0, 8192)}...[truncated]`,
    }));
  });

  it("leaves unchanged/EDWP statuses alone and preserves update/email failure behavior", async () => {
    const unchanged = trackingFixture({ testers: [tester("tester-1", "in_transit")], xml: "<status>DWP</status>" });
    await expect(unchanged.action(request()).then((response) => response.json())).resolves.toMatchObject({
      updated: 0, results: [{ new_status: null, codes: ["DWP"] }],
    });
    expect(unchanged.update).toHaveBeenCalledTimes(1);
    expect(unchanged.sendEmail).not.toHaveBeenCalled();

    const electronic = trackingFixture({ xml: "<status>EDWP</status>" });
    await expect(electronic.action(request()).then((response) => response.json())).resolves.toMatchObject({
      updated: 0, results: [{ new_status: null, codes: ["EDWP"] }],
    });

    const updateFailure = trackingFixture({ statusUpdateError: { message: "write denied" } });
    const failed = await updateFailure.action(request());
    expect(failed.status).toBe(502);
    await expect(failed.json()).resolves.toMatchObject({
      results: [{ error: "update failed: write denied", new_status: null }],
    });
    expect(updateFailure.sendEmail).not.toHaveBeenCalled();
  });

  it("keeps email and finish failures best effort after a successful status update", async () => {
    const fixture = trackingFixture({ sendEmailResult: { ok: false, status: 503 }, finishError: { message: "finish unavailable" } });
    const response = await fixture.action(request());
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({ success: true, updated: 1 });
    expect(fixture.log).toHaveBeenCalledWith(expect.stringContaining("send-email HTTP 503"));
    expect(fixture.log).toHaveBeenCalledWith(expect.stringContaining("failed to finish job run run-1"));
  });
});

function trackingFixture(input: {
  xml?: string;
  testers?: Array<{ id: string; tracking_number: string | null; status: string }>;
  lease?: { acquired: boolean; run_id: string | null; reason: string; lease_until: string | null };
  testerLoadError?: unknown;
  statusUpdateError?: { message: string } | null;
  sendEmailResult?: { ok: boolean; status: number };
  finishError?: { message: string } | null;
  now?: () => Date;
} = {}) {
  const lease = input.lease ?? { acquired: true, run_id: "run-1", reason: "claimed", lease_until: "2030-01-01T00:20:00Z" };
  const finish = vi.fn();
  const rpc = vi.fn(async (name: string, params: Record<string, unknown>) => {
    if (name === "platform_claim_job_run") return { data: [lease] };
    if (name === "platform_finish_job_run_v2") {
      finish(params);
      return { data: input.finishError ? null : true, error: input.finishError ?? undefined };
    }
    return { data: false };
  });
  const update = vi.fn((_row: Record<string, unknown>) => ({
    eq: vi.fn().mockResolvedValue({ error: null }),
  }));
  const statusUpdate = vi.fn((_row: Record<string, unknown>) => ({
    eq: vi.fn().mockResolvedValue({ error: input.statusUpdateError ?? null }),
  }));
  const limit = vi.fn().mockResolvedValue({ data: input.testers ?? [tester("tester-1")], error: input.testerLoadError ?? null });
  const client = {
    rpc,
    auth: { getUser: vi.fn().mockResolvedValue({ data: { user: null } }) },
    from: (table: string) => table === "admin_users"
      ? { select: () => ({ eq: () => ({ maybeSingle: vi.fn().mockResolvedValue({ data: null }) }) }) }
      : {
        select: () => ({
          in: () => ({ not: () => ({ order: () => ({ limit }) }) }),
        }),
        update: (row: Record<string, unknown>) => row.status ? statusUpdate(row) : update(row),
      },
  } as unknown as CarrierTrackingClient;
  const sendEmail = vi.fn().mockResolvedValue(input.sendEmailResult ?? { ok: true, status: 200 });
  const fetchImpl = vi.fn().mockResolvedValue(new Response(input.xml ?? "<status>DWP</status>"));
  const log = vi.fn();
  return {
    action: createTrackingRefreshAction({
      createClient: () => client,
      fetchImpl: fetchImpl as never,
      callSendEmailImpl: sendEmail,
      providerUsername: "user",
      providerPassword: "pass",
      cronSecret: "cron-secret",
      now: input.now ?? (() => new Date("2030-01-01T00:00:00.000Z")),
      log,
    }),
    rpc, update, statusUpdate, sendEmail, fetchImpl, finish, limit, log,
  };
}

function tester(id: string, status = "shipped") { return { id, tracking_number: `TRK-${id}`, status }; }
function sequenceNow(times: number[]): () => Date {
  let index = 0;
  return () => new Date(Math.min(times[index++] ?? times.at(-1) ?? 0, 99_999));
}

function request(input: {
  driver?: string;
  triggerSource?: string;
  cronSchedule?: string;
  providerCronSchedule?: string;
} = {}): Request {
  return new Request("https://example.test", {
    method: "POST",
    headers: {
      Authorization: "Bearer cron-secret",
      "Content-Type": "application/json",
      "x-job-driver": input.driver ?? SCHEDULED_CRON_DRIVER,
      ...(input.providerCronSchedule ? { "x-vercel-cron-schedule": input.providerCronSchedule } : {}),
    },
    body: JSON.stringify({
      driver: input.driver ?? SCHEDULED_CRON_DRIVER,
      trigger_source: input.triggerSource ?? "scheduled_manual",
      cron_schedule: input.cronSchedule,
    }),
  });
}
