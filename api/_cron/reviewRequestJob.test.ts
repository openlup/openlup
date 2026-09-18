import { readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { VercelRequest } from "../../server/_lib/types/vercel.js";

const { mockClaim, mockFinish } = vi.hoisted(() => ({
  mockClaim: vi.fn(),
  mockFinish: vi.fn(),
}));

vi.mock("./platformJobRunner.js", () => ({
  claimJobRun: mockClaim,
  finishJobRun: mockFinish,
}));

import { runReviewRequestCron } from "./reviewRequestJob.js";

function request(headers: Record<string, string> = {}, method = "GET"): VercelRequest {
  return { method, headers } as unknown as VercelRequest;
}
const authed = () => request({ authorization: "Bearer secret" });

const FULL_ENV = {
  CRON_SECRET: "secret",
  SUPABASE_URL: "https://x.supabase.co",
  SUPABASE_SERVICE_ROLE_KEY: "service",
  COMMERCE_REVIEW_REQUEST_ENABLED: "true",
};

function fakeGatewayFactory(client: unknown) {
  const asService = vi.fn(async (callback: (serviceClient: unknown) => unknown) => callback(client));
  const factory = vi.fn(() => ({ asService }));
  return { factory, asService };
}

describe("runReviewRequestCron — guards + enqueue", () => {
  beforeEach(() => {
    mockClaim.mockReset();
    mockFinish.mockReset();
    mockFinish.mockResolvedValue(undefined);
  });
  afterEach(() => vi.clearAllMocks());

  it("keeps the cron composition free of direct Supabase client construction", () => {
    const source = readFileSync("api/_cron/reviewRequestJob.ts", "utf8");
    expect(source).not.toMatch(/@supabase\/supabase-js|createClient\s*\(/);
    expect(source).toContain("createSupabaseDataGateway");
    expect(source).toContain(".asService(");
  });

  it("405s a non-GET/POST method", async () => {
    expect((await runReviewRequestCron(request({}, "DELETE"), FULL_ENV, vi.fn() as never)).status).toBe(405);
  });

  it("503s when CRON_SECRET is unset", async () => {
    const r = await runReviewRequestCron(authed(), { ...FULL_ENV, CRON_SECRET: undefined }, vi.fn() as never);
    expect(r.status).toBe(503);
    expect(r.body.error).toBe("cron_secret_required");
  });

  it("401s on a wrong bearer", async () => {
    expect((await runReviewRequestCron(request({ authorization: "Bearer nope" }), FULL_ENV, vi.fn() as never)).status).toBe(401);
  });

  it("skips (200) when the flag is not 'true', before any client work", async () => {
    const factory = vi.fn();
    const r = await runReviewRequestCron(authed(), { ...FULL_ENV, COMMERCE_REVIEW_REQUEST_ENABLED: "false" }, factory as never);
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ ok: true, skipped: true, reason: "review_request_disabled" });
    expect(factory).not.toHaveBeenCalled();
  });

  it("503s when supabase env is missing", async () => {
    const r = await runReviewRequestCron(authed(), { ...FULL_ENV, SUPABASE_URL: undefined, VITE_SUPABASE_URL: undefined }, vi.fn() as never);
    expect(r.status).toBe(503);
    expect(r.body.error).toBe("supabase_env_required");
  });

  it("skips when the lease is not acquired", async () => {
    mockClaim.mockResolvedValue({ acquired: false, runId: null, reason: "lease_held" });
    const { factory, asService } = fakeGatewayFactory({ rpc: vi.fn() });
    const r = await runReviewRequestCron(authed(), FULL_ENV, factory as never);
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ skipped: true, reason: "lease_held" });
    expect(asService).toHaveBeenCalledOnce();
  });

  it("mounts the production retention binding for the direct bundle", async () => {
    const factory = vi.fn();
    const planAndDispatch = vi.fn(async () => ({ ok: true, scanned: 1, planned: 1, refused: 0, replayed: 0, accepted: 1, failed: 0 }));
    const resolver = vi.fn(() => ({
      binding: { identity: "node-postgres", run: (work: (value: { planAndDispatch: typeof planAndDispatch }) => Promise<unknown>) => work({ planAndDispatch }) },
    }));
    const result = await runReviewRequestCron(authed(), {
      ...FULL_ENV,
      PLATFORM_BUNDLE: "node-postgres",
      DATABASE_URL: "postgres://db",
    }, factory as never, resolver as never);
    expect(result.status).toBe(200);
    expect(result.body).toMatchObject({ kind: "review_request", scanned: 1, accepted: 1 });
    expect(planAndDispatch).toHaveBeenCalledWith("review_request", 200);
    expect(factory).not.toHaveBeenCalled();
  });

  it("scans both touchpoints and reports the per-scan + total counts on success", async () => {
    mockClaim.mockResolvedValue({ acquired: true, runId: "run_1", reason: null });
    const rpc = vi.fn((name: string) =>
      Promise.resolve({ data: name === "enqueue_review_requests" ? 7 : 2, error: null }),
    );
    const { factory, asService } = fakeGatewayFactory({ rpc });
    const r = await runReviewRequestCron(authed(), FULL_ENV, factory as never);
    expect(rpc).toHaveBeenCalledWith("enqueue_review_requests", { p_limit: 200 });
    expect(rpc).toHaveBeenCalledWith("enqueue_review_effects", { p_limit: 200 });
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ ok: true, enqueued: 9, enqueuedRequests: 7, enqueuedEffects: 2 });
    expect(asService).toHaveBeenCalledOnce();
    expect(mockFinish).toHaveBeenCalled();
  });

  it("502s and records failure when a scan RPC errors", async () => {
    mockClaim.mockResolvedValue({ acquired: true, runId: "run_1", reason: null });
    const rpc = vi.fn().mockResolvedValue({ data: null, error: { message: "boom" } });
    const { factory } = fakeGatewayFactory({ rpc });
    const r = await runReviewRequestCron(authed(), FULL_ENV, factory as never);
    expect(r.status).toBe(502);
    expect(r.body).toMatchObject({ ok: false });
  });
});
