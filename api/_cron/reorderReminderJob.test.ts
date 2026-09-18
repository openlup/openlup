import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import type { VercelRequest } from "../../server/_lib/types/vercel.js";
import { runReorderReminderCron } from "./reorderReminderJob.js";

function request(headers: Record<string, string> = {}, method = "GET"): VercelRequest {
  return { method, headers } as unknown as VercelRequest;
}
const authed = () => request({ authorization: "Bearer secret" });

const FULL_ENV = {
  CRON_SECRET: "secret",
  SUPABASE_URL: "https://x.supabase.co",
  SUPABASE_SERVICE_ROLE_KEY: "service",
  COMMERCE_REORDER_REMINDER_ENABLED: "true",
};

function fakeClient(rpcImpl: (name: string, args: Record<string, unknown>) => { data: unknown; error: { message?: string } | null }) {
  const calls: { name: string; args: Record<string, unknown> }[] = [];
  const client = {
    rpc(name: string, args: Record<string, unknown>) {
      calls.push({ name, args });
      return Promise.resolve(rpcImpl(name, args));
    },
  };
  return { client, calls };
}

function defaultRpc(enqueue: { enqueued: number }) {
  return (name: string) => {
    if (name === "platform_claim_job_run") {
      return { data: [{ acquired: true, run_id: "run_1", reason: "ok" }], error: null };
    }
    if (name === "enqueue_reorder_reminders") {
      return { data: enqueue, error: null };
    }
    return { data: null, error: null };
  };
}

function fakeGatewayFactory(client: unknown) {
  const asService = vi.fn(async (callback: (serviceClient: unknown) => unknown) => callback(client));
  const factory = vi.fn(() => ({ asService }));
  return { factory, asService };
}

describe("runReorderReminderCron — fail-closed guards", () => {
  it("keeps the cron composition free of direct Supabase client construction", () => {
    const source = readFileSync("api/_cron/reorderReminderJob.ts", "utf8");
    expect(source).not.toMatch(/@supabase\/supabase-js|createClient\s*\(/);
    expect(source).toContain("createSupabaseDataGateway");
    expect(source).toContain(".asService(");
  });

  it("405s a non-GET/POST method", async () => {
    expect((await runReorderReminderCron(request({}, "DELETE"), FULL_ENV, vi.fn() as never)).status).toBe(405);
  });

  it("503s when CRON_SECRET is unset", async () => {
    const r = await runReorderReminderCron(authed(), { ...FULL_ENV, CRON_SECRET: undefined }, vi.fn() as never);
    expect(r.status).toBe(503);
    expect(r.body.error).toBe("cron_secret_required");
  });

  it("401s on a wrong bearer", async () => {
    expect((await runReorderReminderCron(request({ authorization: "Bearer nope" }), FULL_ENV, vi.fn() as never)).status).toBe(401);
  });

  it("skips (200) when the flag is not 'true', before any client work", async () => {
    const factory = vi.fn();
    const r = await runReorderReminderCron(authed(), { ...FULL_ENV, COMMERCE_REORDER_REMINDER_ENABLED: "false" }, factory as never);
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ ok: true, skipped: true, reason: "reorder_reminder_disabled" });
    expect(factory).not.toHaveBeenCalled();
  });

  it("503s when supabase env is missing", async () => {
    const r = await runReorderReminderCron(authed(), { ...FULL_ENV, SUPABASE_URL: undefined, VITE_SUPABASE_URL: undefined }, vi.fn() as never);
    expect(r.status).toBe(503);
    expect(r.body.error).toBe("supabase_env_required");
  });
});

describe("runReorderReminderCron — enqueue", () => {
  it("mounts the production retention binding for the direct bundle", async () => {
    const factory = vi.fn();
    const planAndDispatch = vi.fn(async () => ({ ok: true, scanned: 3, planned: 2, refused: 1, replayed: 0, accepted: 2, failed: 1 }));
    const resolver = vi.fn(() => ({
      binding: { identity: "node-postgres", run: (work: (value: { planAndDispatch: typeof planAndDispatch }) => Promise<unknown>) => work({ planAndDispatch }) },
    }));
    const result = await runReorderReminderCron(authed(), {
      ...FULL_ENV,
      PLATFORM_BUNDLE: "node-postgres",
      DATABASE_URL: "postgres://db",
    }, factory as never, resolver as never);
    expect(result.status).toBe(200);
    expect(result.body).toMatchObject({ kind: "reorder_reminder", scanned: 3, accepted: 2 });
    expect(planAndDispatch).toHaveBeenCalledWith("reorder_reminder", 200);
    expect(factory).not.toHaveBeenCalled();
  });

  it("calls the enqueue RPC and reports the count", async () => {
    const { client, calls } = fakeClient(defaultRpc({ enqueued: 4 }));
    const { factory, asService } = fakeGatewayFactory(client);
    const r = await runReorderReminderCron(authed(), FULL_ENV, factory as never);
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ ok: true, enqueued: 4 });
    expect(asService).toHaveBeenCalledOnce();
    const enqueueCall = calls.find((c) => c.name === "enqueue_reorder_reminders");
    expect(enqueueCall).toBeTruthy();
    expect(enqueueCall?.args).toMatchObject({ p_limit: 200 });
  });

  it("502s when the enqueue RPC errors", async () => {
    const rpc = (name: string) => {
      if (name === "platform_claim_job_run") return { data: [{ acquired: true, run_id: "run_1", reason: "ok" }], error: null };
      if (name === "enqueue_reorder_reminders") return { data: null, error: { message: "boom" } };
      return { data: null, error: null };
    };
    const { client } = fakeClient(rpc);
    const { factory } = fakeGatewayFactory(client);
    const r = await runReorderReminderCron(authed(), FULL_ENV, factory as never);
    expect(r.status).toBe(502);
    expect(r.body).toMatchObject({ ok: false, reason: "boom" });
  });

  it("skips (200) when the lease is not acquired", async () => {
    const rpc = (name: string) => {
      if (name === "platform_claim_job_run") return { data: [{ acquired: false, run_id: null, reason: "leased" }], error: null };
      return { data: null, error: null };
    };
    const { client, calls } = fakeClient(rpc);
    const { factory } = fakeGatewayFactory(client);
    const r = await runReorderReminderCron(authed(), FULL_ENV, factory as never);
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ ok: true, skipped: true, reason: "leased" });
    expect(calls.find((c) => c.name === "enqueue_reorder_reminders")).toBeUndefined();
  });
});
