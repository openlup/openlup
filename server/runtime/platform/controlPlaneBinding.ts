import { createPlatformControlPlanePort, platformControlPlaneSql } from "../../adapters/platformControlPlane.js";
import { createPostgresPlatformControlPlanePort } from "../../adapters/postgres/platformControlPlane.js";
import { createServiceClient, readSupabaseDataGatewayEnv } from "../../adapters/supabase/dataGatewayClientFactory.js";
import type { PlatformControlPlanePort } from "../../../src/domains/platform/ports.js";
import { resolveBundleId } from "../../domains/platform-runtime/platformKernel.js";
import type { PgQueryExecutor } from "../../adapters/postgres/queryBuilder.js";

type Env = Record<string, string | undefined>;
type ManagedClient = { rpc(name: string, args: Record<string, unknown>): PromiseLike<{
  data: unknown; error: { code?: string; message?: string } | null;
}> };

export interface PlatformControlPlaneBinding {
  readonly identity: string;
  run<T>(work: (port: PlatformControlPlanePort) => Promise<T>): Promise<T>;
}

export type DirectPlatformWatchdogResult = {
  status: number;
  body: Record<string, unknown>;
};

/** Execute the bounded public-bundle watchdog over persisted neutral job facts. */
export async function runDirectPlatformWatchdogTick(
  env: Env,
  now: Date,
  checkOnly: boolean,
  resolver: typeof resolvePlatformControlPlaneBinding = resolvePlatformControlPlaneBinding,
): Promise<DirectPlatformWatchdogResult> {
  const operatorId = env.PLATFORM_OPERATOR_ID?.trim() ?? "";
  const resolved = resolver(env, { operatorId });
  if (!resolved.binding) return { status: 500, body: {
    ok: false, health: "configuration_failure", firingCount: 0, error: resolved.error,
  } };
  try {
    return await resolved.binding.run(async (port) => {
      const snapshot = await port.readControlPlane({});
      const failedJobs = snapshot.jobs.filter((job) => job.enabled && job.lastStatus === "failed");
      const health = failedJobs.length > 0 ? "degraded" as const : "healthy" as const;
      const recorded = checkOnly ? null : await port.mutateControlPlane({
        action: "record-heartbeat",
        idempotencyKey: `platform-watchdog:${now.toISOString()}`,
        health,
        firingCount: failedJobs.length,
        maxSeverity: failedJobs.length > 0 ? "p2" : null,
        promotionReady: failedJobs.length === 0,
      });
      return { status: 200, body: {
        ok: true, health, firingCount: failedJobs.length,
        failedJobs: failedJobs.map((job) => job.jobName),
        checkedAt: now.toISOString(), heartbeatRecorded: recorded != null,
        replayed: recorded?.replayed ?? false,
      } };
    });
  } catch {
    return { status: 502, body: {
      ok: false, health: "transport_failure", firingCount: 0,
      error: "platform_control_plane_unavailable",
    } };
  }
}

export function resolvePlatformControlPlaneBinding(
  env: Env,
  options: {
    operatorId: string;
    managedClientFactory?: (env: NonNullable<ReturnType<typeof readSupabaseDataGatewayEnv>>) => ManagedClient;
  },
): { binding: PlatformControlPlaneBinding; error?: undefined } | { binding?: undefined; error: string } {
  const operatorId = options.operatorId.trim();
  if (!operatorId) return { error: "platform_control_operator_id_required" };
  const bundleId = resolveBundleId(env);
  if (bundleId === "node-postgres") {
    const connectionString = env.DATABASE_URL?.trim() ?? "";
    if (!connectionString) return { error: "database_url_required" };
    return { binding: {
      identity: bundleId,
      async run(work) {
        const port = createPostgresPlatformControlPlanePort({ connectionString }, { operatorId });
        try { return await work(port); } finally { await port.close(); }
      },
    } };
  }
  const managedEnv = readSupabaseDataGatewayEnv(env);
  if (!managedEnv) return { error: "supabase_env_required" };
  return { binding: {
    identity: bundleId,
    run: (work) => {
      const client = (options.managedClientFactory ?? createServiceClient)(managedEnv) as ManagedClient;
      return work(createPlatformControlPlanePort(createManagedExecutor(client), operatorId));
    },
  } };
}

function createManagedExecutor(client: ManagedClient): PgQueryExecutor {
  return { async query(sql, values = []) {
    const descriptor = MANAGED_CALLS.get(sql);
    if (!descriptor) throw new Error("platform_control_managed_routine_unknown");
    const args = Object.fromEntries(descriptor.args.map((name, index) => [name, values[index]]));
    const { data, error } = await client.rpc(descriptor.routine, args);
    if (error) throw Object.assign(new Error(error.message ?? `${descriptor.routine}_failed`), { code: error.code });
    if (Array.isArray(data)) return { rows: data as Record<string, unknown>[] };
    if (data && typeof data === "object") return { rows: [data as Record<string, unknown>] };
    return { rows: [{ [descriptor.routine]: data }] };
  } };
}

const sql = platformControlPlaneSql;
const MANAGED_CALLS = new Map<string, { routine: string; args: string[] }>([
  [sql.active, { routine: "platform_control_operator_is_active", args: ["p_principal_id"] }],
  [sql.setControl, { routine: "platform_control_set_control", args: ["p_operator_id", "p_idempotency_key", "p_command_fingerprint", "p_control_key", "p_enabled"] }],
  [sql.heartbeat, { routine: "platform_control_record_heartbeat", args: ["p_operator_id", "p_idempotency_key", "p_command_fingerprint", "p_health", "p_firing_count", "p_max_severity", "p_promotion_ready"] }],
  [sql.controls, { routine: "platform_control_list_controls", args: ["p_operator_id"] }],
  [sql.jobs, { routine: "platform_control_list_jobs", args: ["p_operator_id"] }],
  [sql.alerts, { routine: "platform_control_list_alerts", args: ["p_operator_id"] }],
]);
