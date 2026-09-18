import {
  communicationsControlPlaneSql,
  createCommunicationsControlPlanePort,
} from "../../adapters/communicationsControlPlane.js";
import { createCapturedTransactionalDelivery } from "../../adapters/captured/transactionalDelivery.js";
import { createPostgresCommunicationsControlPlanePort } from "../../adapters/postgres/communicationsControlPlane.js";
import { createServiceClient, readSupabaseDataGatewayEnv } from "../../adapters/supabase/dataGatewayClientFactory.js";
import type { CommunicationControlPlanePort } from "../../../src/domains/communications/ports.js";
import type { CapturedTransactionalDeliveryPort } from "../../../src/domains/communications/transactionalDeliveryPort.js";
import { resolveBundleId } from "../../domains/platform-runtime/platformKernel.js";
import type { PgQueryExecutor } from "../../adapters/postgres/queryBuilder.js";

type Env = Record<string, string | undefined>;
type ManagedClient = { rpc(name: string, args: Record<string, unknown>): PromiseLike<{ data: unknown; error: { code?: string; message?: string } | null }> };

export interface CommunicationsControlPlaneBinding {
  readonly identity: string;
  run<T>(work: (port: CommunicationControlPlanePort) => Promise<T>): Promise<T>;
}

export function resolveCommunicationsControlPlaneBinding(
  env: Env,
  options: {
    operatorId: string;
    capturedFactory?: () => CapturedTransactionalDeliveryPort;
    managedClientFactory?: (env: NonNullable<ReturnType<typeof readSupabaseDataGatewayEnv>>) => ManagedClient;
  },
): { binding: CommunicationsControlPlaneBinding; error?: undefined } | { binding?: undefined; error: string } {
  const operatorId = options.operatorId.trim();
  if (!operatorId) return { error: "communications_operator_id_required" };
  const capturedFactory = options.capturedFactory ?? createCapturedTransactionalDelivery;
  const bundleId = resolveBundleId(env);
  if (bundleId === "node-postgres") {
    const connectionString = env.DATABASE_URL?.trim() ?? "";
    if (!connectionString) return { error: "database_url_required" };
    return { binding: {
      identity: bundleId,
      async run(work) {
        const port = createPostgresCommunicationsControlPlanePort(
          { connectionString }, { operatorId, capturedFactory },
        );
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
      return work(createCommunicationsControlPlanePort(
        createManagedQueryExecutor(client),
        { operatorId, capturedDelivery: capturedFactory() },
      ));
    },
  } };
}

function createManagedQueryExecutor(client: ManagedClient): PgQueryExecutor {
  return { async query(sql, values = []) {
    const descriptor = MANAGED_CALLS.get(sql);
    if (!descriptor) throw new Error("communications_managed_routine_unknown");
    const args = Object.fromEntries(descriptor.args.map((name, index) => [name, values[index]]));
    const { data, error } = await client.rpc(descriptor.routine, args);
    if (error) throw Object.assign(new Error(error.message ?? `${descriptor.routine}_failed`), { code: error.code });
    if (Array.isArray(data)) return { rows: data as Record<string, unknown>[] };
    if (data && typeof data === "object") return { rows: [data as Record<string, unknown>] };
    return { rows: [{ [descriptor.routine]: data }] };
  } };
}

const entries = communicationsControlPlaneSql;
const MANAGED_CALLS = new Map<string, { routine: string; args: string[] }>([
  [entries.active, { routine: "communications_operator_is_active", args: ["p_principal_id"] }],
  [entries.setControl, { routine: "communications_set_delivery_control", args: ["p_operator_id", "p_control_key", "p_enabled"] }],
  [entries.setTemplate, { routine: "communications_set_delivery_template", args: ["p_operator_id", "p_template_reference", "p_control_key", "p_active"] }],
  [entries.prepare, { routine: "communications_prepare_delivery_command", args: ["p_operator_id", "p_idempotency_key", "p_command_fingerprint", "p_template_reference", "p_recipient_fingerprint"] }],
  [entries.accepted, { routine: "communications_record_delivery_accepted", args: ["p_operator_id", "p_idempotency_key", "p_command_fingerprint", "p_delivery_reference"] }],
  [entries.failed, { routine: "communications_record_delivery_failed", args: ["p_operator_id", "p_idempotency_key", "p_command_fingerprint", "p_error_code"] }],
  [entries.receipt, { routine: "transactional_delivery_read_receipt", args: ["p_idempotency_key"] }],
  [entries.operations, { routine: "communications_list_delivery_operations", args: ["p_operator_id", "p_page", "p_page_size"] }],
  [entries.events, { routine: "communications_list_delivery_events", args: ["p_operator_id", "p_idempotency_key"] }],
  [entries.controls, { routine: "communications_list_delivery_controls", args: ["p_operator_id"] }],
  [entries.templates, { routine: "communications_list_delivery_templates", args: ["p_operator_id"] }],
  [entries.health, { routine: "communications_delivery_health", args: ["p_operator_id"] }],
  [entries.readiness, { routine: "communications_delivery_readiness", args: ["p_operator_id"] }],
]);
