import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import type { VercelRequest } from "../../server/_lib/types/vercel.js";
import type { SupabaseDataGatewayEnv } from "../../server/adapters/supabase/dataGatewayClientFactory.js";
import type { DataGatewayPort } from "../../src/domains/platform-runtime/ports.js";
import { runCommunicationSyncDispatchCron } from "./communicationSyncDispatchJob.ts";

const BASE_ENV = {
  CRON_SECRET: "cron-secret",
  SUPABASE_URL: "https://proj.supabase.co",
  SUPABASE_SERVICE_ROLE_KEY: "service-role",
  COMMUNICATION_SYNC_DISPATCH_ENABLED: "true",
};

const SYNC_EVENT = {
  id: "event-1",
  claim_token: "claim-1",
  contact_id: "contact-1",
  normalized_email: "ala@example.com",
  event_type: "subscribe",
  purpose: "marketing_newsletter",
  payload: {},
  attempt_count: 0,
  origin_provider_kind: null,
  origin_provider_event_id: null,
  remote_profile_id: null,
  remote_list_id: null,
};

function req(method = "GET", authorization?: string): VercelRequest {
  return { method, headers: authorization ? { authorization } : {} } as unknown as VercelRequest;
}

type RpcCall = { name: string; args: Record<string, unknown> };

function fakeGateway(client: unknown) {
  const asService = vi.fn(async (work: (gateway: unknown) => Promise<unknown>) => work(client));
  const factory = vi.fn((_env: SupabaseDataGatewayEnv): DataGatewayPort => ({
    asActor: async () => {
      throw new Error("unexpected_actor_gateway_call");
    },
    asService: asService as unknown as DataGatewayPort["asService"],
  }));
  return { factory, asService };
}

function fakeClient(options: { acquired?: boolean; events?: unknown[] } = {}) {
  const calls: RpcCall[] = [];
  const client = {
    async rpc(name: string, args: Record<string, unknown>) {
      calls.push({ name, args });
      if (name === "platform_claim_job_run") {
        return {
          data: [{
            acquired: options.acquired ?? true,
            run_id: options.acquired === false ? null : "run-1",
            reason: options.acquired === false ? "already_running" : "claimed",
          }],
          error: null,
        };
      }
      if (name === "communication_claim_sync_outbox") return { data: options.events ?? [], error: null };
      if (name === "communication_mark_sync_outbox_sent") return { data: true, error: null };
      if (name === "platform_finish_job_run_v2") return { data: null, error: null };
      return { data: null, error: new Error(`unexpected rpc ${name}`) };
    },
  };
  return { client, calls };
}

describe("runCommunicationSyncDispatchCron DB boundary", () => {
  it("keeps the dispatch entrypoint off direct Supabase SDK imports", () => {
    const source = readFileSync(join(process.cwd(), "api/_cron/communicationSyncDispatchJob.ts"), "utf8");
    expect(source).not.toContain("@supabase/supabase-js");
    expect(source).not.toMatch(/\bcreateClient(?:\s*<[^>]+>)?\s*\(/);
    expect(source).toContain("createSupabaseDataGateway");
    expect(source).toContain("readSupabaseDataGatewayEnv");
  });

  it("does not build a gateway before auth, flag, and env gates pass", async () => {
    const gateway = fakeGateway(fakeClient().client);

    expect(await runCommunicationSyncDispatchCron(req("GET", "Bearer bad"), BASE_ENV, gateway.factory)).toMatchObject({
      status: 401,
    });
    expect(await runCommunicationSyncDispatchCron(req("GET", "Bearer cron-secret"), {
      ...BASE_ENV,
      COMMUNICATION_SYNC_DISPATCH_ENABLED: "false",
    }, gateway.factory)).toMatchObject({
      status: 200,
      body: { skipped: true, reason: "communication_sync_dispatch_disabled" },
    });
    expect(await runCommunicationSyncDispatchCron(req("GET", "Bearer cron-secret"), {
      CRON_SECRET: "cron-secret",
      COMMUNICATION_SYNC_DISPATCH_ENABLED: "true",
    }, gateway.factory)).toMatchObject({
      status: 503,
      body: { error: "supabase_env_required" },
    });

    expect(gateway.factory).not.toHaveBeenCalled();
  });

  it("runs lease, store, and finish through one service gateway client", async () => {
    const { client, calls } = fakeClient({ events: [SYNC_EVENT] });
    const gateway = fakeGateway(client);

    const result = await runCommunicationSyncDispatchCron(req("POST", "Bearer cron-secret"), BASE_ENV, gateway.factory);

    expect(result.status).toBe(200);
    expect(result.body).toMatchObject({ ok: true, checked: 1, updated: 1, sent: 1, failures: 0 });
    expect(gateway.factory).toHaveBeenCalledTimes(1);
    expect(gateway.asService).toHaveBeenCalledTimes(1);
    expect(calls.map((call) => call.name)).toEqual([
      "platform_claim_job_run",
      "communication_claim_sync_outbox",
      "communication_mark_sync_outbox_sent",
      "platform_finish_job_run_v2",
    ]);
  });

  it("does not dispatch or finish when the lease is not acquired", async () => {
    const { client, calls } = fakeClient({ acquired: false });
    const gateway = fakeGateway(client);

    const result = await runCommunicationSyncDispatchCron(req("GET", "Bearer cron-secret"), BASE_ENV, gateway.factory);

    expect(result).toMatchObject({
      status: 200,
      body: { ok: true, skipped: true, reason: "already_running", run_id: null },
    });
    expect(calls.map((call) => call.name)).toEqual(["platform_claim_job_run"]);
  });
});
