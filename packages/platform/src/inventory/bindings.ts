import type { z } from "zod";
import { createPostgresAdminInventoryPort } from "./adminInventory.js";
import type { InventoryMutationPort, InventoryReadPort } from "./ports.js";
import type { NewPurchaseStockReadPort } from "./newPurchaseStockAvailability.js";
import { createInventorySubscriptionForecastResponseSchema } from "./schemas.js";

export interface InventoryBindingDependencies {
  dataKind: string;
  provider: { stockMasterProvider: string; providerSchema: z.ZodType<string> };
  executor?: { query(text: string, values?: unknown[]): Promise<{ rows: Record<string, unknown>[] }> } | null;
  createManagedStore?: (provider: InventoryBindingDependencies["provider"]) => {
    readPort: InventoryReadPort; mutationPort: InventoryMutationPort;
  } | null;
  newPurchaseStockReadPort?: NewPurchaseStockReadPort | null;
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
  if (deps.dataKind === "postgres") {
    if (!deps.executor || typeof deps.executor.query !== "function") return refused("inventory_executor_required");
    readPort = mutationPort = createPostgresAdminInventoryPort(deps.executor, deps.provider, deps.now);
  } else if (deps.dataKind === "supabase") {
    const store = deps.createManagedStore?.(deps.provider);
    if (!store) return refused("inventory_managed_store_required");
    ({ readPort, mutationPort } = store);
  } else return refused("inventory_store_incompatible");
  if (![readPort?.listStock, readPort?.listReservations, readPort?.checkAtp, readPort?.forecastSubscriptions, mutationPort?.adjustStock].every(fn => typeof fn === "function")) return refused("inventory_store_incompatible");
  const responseSchema = createInventorySubscriptionForecastResponseSchema(deps.provider.providerSchema);
  const native = deps.dataKind === "postgres";
  const stockRead = native ? null : deps.newPurchaseStockReadPort;
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
      newPurchaseStockRead: native ? "inventory_native_new_purchase_stock_read_unsupported"
        : newPurchaseStockReadPort ? null : "inventory_new_purchase_stock_reader_required",
    },
  };
}
