import type { NewPurchaseStockReadPort } from "./newPurchaseStockAvailability.js";
import { parseStockReadResponse } from "./stockReadResponse.js";

/** Minimal service-role RPC seam; transport and credentials remain host-owned. */
export interface ManagedStockRpc {
  rpc(name: string, args: Record<string, unknown>): PromiseLike<{
    data: unknown;
    error: { message: string; code?: string } | null;
  }>;
}

/** Read-only managed ATP preview with fixed subscription priority. */
export function createManagedStockAvailability(client: ManagedStockRpc, options: { now: () => string }): NewPurchaseStockReadPort {
  return {
    async read(input) {
      if (input.horizonDays !== 14 || input.excludeOrderId !== null) throw new Error("managed_stock_read_options_unsupported");
      if (!input.skus.length) return new Map();
      const { data, error } = await client.rpc("inventory_new_purchase_stock_read", { p_skus: input.skus, p_as_of: options.now() });
      if (error) throw error;
      return parseStockReadResponse(data);
    },
  };
}
