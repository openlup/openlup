import { createManagedStockAvailability, type ManagedStockRpc } from "./managedStockAvailability.js";
import type { z } from "zod";
import { createPostgresAdminInventoryPort } from "./adminInventory.js";
import type { InventoryMutationPort, InventoryReadPort } from "./ports.js";
import type { NewPurchaseStockReadPort } from "./newPurchaseStockAvailability.js";
import { createPostgresStockAvailability } from "./postgresStockAvailability.js";
import { createInventorySubscriptionForecastResponseSchema } from "./schemas.js";

export interface InventoryBindingDependencies {
  dataKind: string;
  provider: { stockMasterProvider: string; providerSchema: z.ZodType<string> };
  executor?: { query(text: string, values?: unknown[]): Promise<{ rows: Record<string, unknown>[] }> } | null;
  createManagedStore?: (provider: InventoryBindingDependencies["provider"]) => {
    readPort: InventoryReadPort; mutationPort: InventoryMutationPort;
  } | null;
  newPurchaseStockReadPort?: NewPurchaseStockReadPort | null;
  stockSourceKey?: string;
  stockRpc?: ManagedStockRpc;
  now?: () => string;
}

export interface InventoryBindings {
  readPort: InventoryReadPort | null;
  mutationPort: InventoryMutationPort | null;
  newPurchaseStockReadPort: NewPurchaseStockReadPort | null;
  readiness: { ready: boolean; reason: string | null };
  unsupported: { newPurchaseStockRead: string | null };
}

/** Select one store only. Factories declare bindings, never discover or activate a host. */
export function createInventoryBindings(deps: InventoryBindingDependencies): InventoryBindings {
  const refused = (reason: string): InventoryBindings => ({
    readPort: null, mutationPort: null, newPurchaseStockReadPort: null,
    readiness: { ready: false, reason }, unsupported: { newPurchaseStockRead: reason },
  });
  if (!deps.provider?.providerSchema?.safeParse(deps.provider.stockMasterProvider).success) return refused("inventory_provider_mismatch");
  let readPort: InventoryReadPort, mutationPort: InventoryMutationPort;
  let stockRead: NewPurchaseStockReadPort | null | undefined;
  if (deps.dataKind === "postgres") {
    if (!deps.executor || typeof deps.executor.query !== "function") return refused("inventory_executor_required");
    readPort = mutationPort = createPostgresAdminInventoryPort(deps.executor, deps.provider, deps.now);
    stockRead = deps.stockSourceKey?.trim()
      ? createPostgresStockAvailability(deps.executor, { sourceKey: deps.stockSourceKey, now: deps.now ?? (() => new Date().toISOString()) }).readPort
      : null;
  } else if (deps.dataKind === "supabase") {
    const store = deps.createManagedStore?.(deps.provider);
    if (!store) return refused("inventory_managed_store_required");
    ({ readPort, mutationPort } = store);
    stockRead = deps.newPurchaseStockReadPort ?? (deps.stockRpc
      ? createManagedStockAvailability(deps.stockRpc, { now: deps.now ?? (() => new Date().toISOString()) }) : null);
  } else return refused("inventory_store_incompatible");
  if (![readPort?.listStock, readPort?.listReservations, readPort?.checkAtp, readPort?.forecastSubscriptions, mutationPort?.adjustStock].every(fn => typeof fn === "function")) return refused("inventory_store_incompatible");
  const responseSchema = createInventorySubscriptionForecastResponseSchema(deps.provider.providerSchema);
  const newPurchaseStockReadPort = typeof stockRead?.read === "function" ? stockRead : null;
  return {
    readPort: {
      listStock: request => readPort.listStock(request),
      listReservations: request => readPort.listReservations(request),
      checkAtp: request => readPort.checkAtp(request),
      forecastSubscriptions: async request => responseSchema.parse(await readPort.forecastSubscriptions(request)),
    },
    mutationPort, newPurchaseStockReadPort,
    readiness: { ready: true, reason: null },
    unsupported: {
      newPurchaseStockRead: newPurchaseStockReadPort ? null : deps.dataKind === "postgres"
        ? "inventory_stock_source_key_required" : "inventory_new_purchase_stock_reader_required",
    },
  };
}
