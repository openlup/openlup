import { buildSubscriptionInventoryForecast as buildForecast } from "@openlup/platform/inventory";
import { inventorySubscriptionForecastResponseSchema, type InventorySubscriptionForecastResponse } from "./contracts.js";

export { forecastSubscriptionInventoryShortages } from "@openlup/platform/inventory";
export type { InventoryProviderStockLine, InventoryHardReservationLine } from "@openlup/platform/inventory/contracts";

export function buildSubscriptionInventoryForecast(
  input: Parameters<typeof buildForecast>[0],
): InventorySubscriptionForecastResponse {
  return buildForecast(input, { stockMasterProvider: "omnipack", providerSchema: inventorySubscriptionForecastResponseSchema.shape.stockMasterProvider }) as InventorySubscriptionForecastResponse;
}
