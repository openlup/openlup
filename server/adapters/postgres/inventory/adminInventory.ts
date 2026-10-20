import { createPostgresAdminInventoryPort as createPort } from "@openlup/platform/inventory";
import { inventorySubscriptionForecastResponseSchema } from "../../../../src/domains/inventory/contracts.js";
import type { PgQueryExecutor } from "../queryBuilder.js";

export function createPostgresAdminInventoryPort(
  executor: PgQueryExecutor,
  now: () => string = () => new Date().toISOString(),
) {
  return createPort(executor, {
    stockMasterProvider: "omnipack",
    providerSchema: inventorySubscriptionForecastResponseSchema.shape.stockMasterProvider,
  }, now);
}
