import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import type { VercelRequest } from "../../server/_lib/types/vercel.js";
import type { SupabaseDataGatewayEnv } from "../../server/adapters/supabase/dataGatewayClientFactory.js";
import type { DataGatewayPort } from "../../src/domains/platform-runtime/ports.js";
import { runCommunicationSyncReconcileCron } from "./communicationSyncReconcileJob.ts";

const BASE_ENV = {
  CRON_SECRET: "cron-secret",
  SUPABASE_URL: "https://proj.supabase.co",
  SUPABASE_SERVICE_ROLE_KEY: "service-role",
  COMMUNICATION_SYNC_RECONCILE_ENABLED: "true",
};

function req(method = "GET", authorization?: string): VercelRequest {
  return { method, headers: authorization ? { authorization } : {} } as unknown as VercelRequest;
}

type RpcCall = { name: string; args: Record<string, unknown> };

function fakeGateway(client: unknown, onEnv?: (env: SupabaseDataGatewayEnv) => void) {
  const asService = vi.fn(async (work: (gateway: unknown) => Promise<unknown>) => work(client));
  const factory = vi.fn((env: SupabaseDataGatewayEnv): DataGatewayPort => {
    onEnv?.(env);
    return {
      asActor: async () => {
        throw new Error("unexpected_actor_gateway_call");
      },
      asService: asService as unknown as DataGatewayPort["asService"],
    };
  });
  return { factory, asService };
}

function fakeClient(options: { acquired?: boolean } = {}) {
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
      if (name === "platform_finish_job_run_v2") return { data: null, error: null };
      return { data: null, error: new Error(`unexpected rpc ${name}`) };
    },
  };
  return { client, calls };
}

describe("runCommunicationSyncReconcileCron DB boundary", () => {
  it("keeps the reconcile entrypoint off direct Supabase SDK imports", () => {
    const source = readFileSync(join(process.cwd(), "api/_cron/communicationSyncReconcileJob.ts"), "utf8");
    expect(source).not.toContain("@supabase/supabase-js");
    expect(source).not.toMatch(/\bcreateClient(?:\s*<[^>]+>)?\s*\(/);
    expect(source).toContain("createSupabaseDataGateway");
    expect(source).toContain("readSupabaseDataGatewayEnv");
  });

  it("does not build a gateway before auth, flag, and env gates pass", async () => {
    const gateway = fakeGateway(fakeClient().client);

    expect(await runCommunicationSyncReconcileCron(req("GET", "Bearer bad"), BASE_ENV, gateway.factory)).toMatchObject({
      status: 401,
    });
    expect(await runCommunicationSyncReconcileCron(req("GET", "Bearer cron-secret"), {
      ...BASE_ENV,
      COMMUNICATION_SYNC_RECONCILE_ENABLED: "false",
    }, gateway.factory)).toMatchObject({
      status: 200,
      body: { skipped: true, reason: "communication_sync_reconcile_disabled" },
    });
    expect(await runCommunicationSyncReconcileCron(req("GET", "Bearer cron-secret"), {
      CRON_SECRET: "cron-secret",
      COMMUNICATION_SYNC_RECONCILE_ENABLED: "true",
    }, gateway.factory)).toMatchObject({
      status: 503,
      body: { error: "supabase_env_required" },
    });

    expect(gateway.factory).not.toHaveBeenCalled();
  });

  it("runs lease and finish through the service gateway", async () => {
    const { client, calls } = fakeClient();
    const gateway = fakeGateway(client, (env) => {
      expect(env).toMatchObject({ url: BASE_ENV.SUPABASE_URL, serviceRoleKey: BASE_ENV.SUPABASE_SERVICE_ROLE_KEY });
    });

    const result = await runCommunicationSyncReconcileCron(req("GET", "Bearer cron-secret"), BASE_ENV, gateway.factory);

    expect(result.status).toBe(200);
    expect(result.body).toMatchObject({ ok: true, skipped: true, reason: "provider_neutral_reconcile_noop" });
    expect(gateway.factory).toHaveBeenCalledTimes(1);
    expect(gateway.asService).toHaveBeenCalledTimes(1);
    expect(calls.map((call) => call.name)).toEqual([
      "platform_claim_job_run",
      "platform_finish_job_run_v2",
    ]);
  });
});
