import type { VercelRequest } from "../../_lib/types/vercel.js";
import {
  authorizeAdminWithUser,
  createAdminAuthClient,
  readBearerToken,
} from "../../_lib/admin-domain/auth.js";
import {
  createManagedAdminInventoryGateway,
  type ManagedAdminInventoryGateway,
} from "../../adapters/managed/inventory/adminInventoryGateway.js";
import { createInventoryBindings } from "@openlup/platform/inventory";
import { inventorySubscriptionForecastResponseSchema } from "../../../src/domains/inventory/contracts.js";
import {
  createPostgresAdminInventoryTransactionLane,
  type PostgresAdminInventoryTransactionLane,
} from "../../adapters/postgres/dataGateway.js";
import type { PgQueryExecutor } from "../../adapters/postgres/queryBuilder.js";
import { resolveAdminAuthBinding } from "../auth/adminAuthBinding.js";
import {
  getBundleDescriptor,
  resolveBundleId,
} from "../../domains/platform-runtime/platformKernel.js";
import type {
  InventoryMutationPort,
  InventoryReadPort,
} from "../../../src/domains/inventory/ports.js";

type Env = Record<string, string | undefined>;

export type InventoryAdminAuthorization =
  | { ok: true; userId: string }
  | { ok: false; code: "UNAUTHORIZED" | "FORBIDDEN"; message: string };

export interface AdminInventoryRuntimeBinding {
  readPort: InventoryReadPort;
  mutationPort: InventoryMutationPort;
  authorizeAdmin: (req: VercelRequest) => Promise<InventoryAdminAuthorization>;
  mutationsEnabled: () => boolean;
}

export interface DirectAdminInventoryBindingInput {
  env: Env;
  accessToken: string | null;
}

export type DirectAdminInventoryBindingFactory = (
  input: DirectAdminInventoryBindingInput,
) => AdminInventoryRuntimeBinding | null;

interface AdminInventoryBindingOptions {
  createManagedGateway?: (
    env: { url: string; serviceRoleKey: string },
  ) => ManagedAdminInventoryGateway;
  createDirectBinding?: DirectAdminInventoryBindingFactory;
}

/** Resolve one request to the inventory adapter owned by the active bundle. */
export function resolveAdminInventoryRuntimeBinding(
  req: VercelRequest,
  env: Env = process.env,
  options: AdminInventoryBindingOptions = {},
): AdminInventoryRuntimeBinding | null {
  const bundleId = resolveBundleId(env);
  const dataKind = getBundleDescriptor(bundleId).capabilities.data;
  const accessToken = readBearerToken(req);

  if (dataKind === "postgres") {
    return (options.createDirectBinding ?? createDirectAdminInventoryBinding)({ env, accessToken });
  }
  if (dataKind !== "supabase") return null;

  const serviceEnv = readSupabaseInventoryEnv(env);
  if (!serviceEnv) return null;
  const binding = createInventoryBindings({ dataKind: "supabase", provider: {
    stockMasterProvider: inventorySubscriptionForecastResponseSchema.shape.stockMasterProvider.value,
    providerSchema: inventorySubscriptionForecastResponseSchema.shape.stockMasterProvider,
  }, createManagedStore: () => {
    const gateway = (options.createManagedGateway ?? createManagedAdminInventoryGateway)(serviceEnv);
    return { readPort: gateway.readPort(), mutationPort: gateway.mutationPort() };
  } });
  if (!binding.readPort || !binding.mutationPort) return null;
  const authClient = createAdminAuthClient(serviceEnv, accessToken);
  return {
    readPort: binding.readPort,
    mutationPort: binding.mutationPort,
    authorizeAdmin: async () => {
      const result = await authorizeAdminWithUser(authClient, accessToken, { allowedRoles: ["admin"] });
      if (result.ok) return { ok: true, userId: result.userId };
      if ("code" in result) return { ok: false, code: result.code, message: result.message };
      return { ok: false, code: "FORBIDDEN", message: "Admin role required" };
    },
    mutationsEnabled: () => env.COMMERCE_INVENTORY_MUTATIONS_ENABLED === "true",
  };
}

const directLanes = new Map<string, PostgresAdminInventoryTransactionLane>();

/** Close app-lifetime direct pools during a graceful host shutdown or live proof. */
export async function closeDirectAdminInventoryRuntimeBindings(): Promise<void> {
  const lanes = [...directLanes.values()];
  directLanes.clear();
  await Promise.all(lanes.map((lane) => lane.close()));
}

function createDirectAdminInventoryBinding(
  input: DirectAdminInventoryBindingInput,
): AdminInventoryRuntimeBinding | null {
  const connectionString = input.env.DATABASE_URL?.trim() ?? "";
  if (!connectionString) return null;
  const auth = resolveAdminAuthBinding(input.env);
  if (!auth.binding) return null;
  let lane = directLanes.get(connectionString);
  if (!lane) {
    lane = createPostgresAdminInventoryTransactionLane({ connectionString });
    directLanes.set(connectionString, lane);
  }
  const binding = createInventoryBindings({ dataKind: "postgres", executor: executorForLane(lane), provider: {
    stockMasterProvider: inventorySubscriptionForecastResponseSchema.shape.stockMasterProvider.value,
    providerSchema: inventorySubscriptionForecastResponseSchema.shape.stockMasterProvider,
  } });
  if (!binding.readPort || !binding.mutationPort) return null;
  return {
    readPort: binding.readPort,
    mutationPort: binding.mutationPort,
    authorizeAdmin: async () => auth.binding!.run(
      input.accessToken,
      async (authorizer) => {
        const result = await authorizer.authorize(input.accessToken, { allowedRoles: ["admin"] });
        if (result.ok === true) return { ok: true as const, userId: result.principalId };
        return { ok: false as const, code: result.code, message: result.message };
      },
    ),
    // Public stock_current is external observation, not an operator-owned ledger.
    mutationsEnabled: () => false,
  };
}

function executorForLane(lane: PostgresAdminInventoryTransactionLane): PgQueryExecutor {
  return { query: (sql, values) => lane.run((gateway) =>
    (gateway as PgQueryExecutor).query(sql, values)) };
}

function readSupabaseInventoryEnv(env: Env): {
  url: string;
  anonKey: string;
  serviceRoleKey: string;
} | null {
  const url = env.SUPABASE_URL ?? env.VITE_SUPABASE_URL;
  const anonKey =
    env.VITE_SUPABASE_PUBLISHABLE_KEY ??
    env.VITE_SUPABASE_ANON_KEY ??
    env.SUPABASE_ANON_KEY;
  const serviceRoleKey = env.SUPABASE_SERVICE_ROLE_KEY;
  return url && anonKey && serviceRoleKey ? { url, anonKey, serviceRoleKey } : null;
}
