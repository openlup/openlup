import {
  createAdminInventoryStockHandler as createStock,
  createAdminInventoryReservationsHandler as createReservations,
  createAdminInventoryAtpCheckHandler as createAtpCheck,
  createAdminInventorySubscriptionForecastHandler as createSubscriptionForecast,
  createAdminInventoryStockAdjustmentHandler as createStockAdjustment,
} from "@openlup/platform/inventory";
import { bffResponder } from "../../_lib/bff/response.js";
import { inventorySubscriptionForecastResponseSchema } from "../../../src/domains/inventory/contracts.js";

export function createAdminInventoryStockHandler(deps: Omit<Parameters<typeof createStock>[0], keyof typeof bffResponder>) {
  return createStock({ ...deps, ...bffResponder });
}
export function createAdminInventoryReservationsHandler(deps: Omit<Parameters<typeof createReservations>[0], keyof typeof bffResponder>) {
  return createReservations({ ...deps, ...bffResponder });
}
export function createAdminInventoryAtpCheckHandler(deps: Omit<Parameters<typeof createAtpCheck>[0], keyof typeof bffResponder>) {
  return createAtpCheck({ ...deps, ...bffResponder });
}
export function createAdminInventorySubscriptionForecastHandler(deps: Omit<Parameters<typeof createSubscriptionForecast>[0], keyof typeof bffResponder | "inventorySubscriptionForecastResponseSchema">) {
  return createSubscriptionForecast({ ...deps, ...bffResponder, inventorySubscriptionForecastResponseSchema });
}
export function createAdminInventoryStockAdjustmentHandler(deps: Omit<Parameters<typeof createStockAdjustment>[0], keyof typeof bffResponder>) {
  return createStockAdjustment({ ...deps, ...bffResponder });
}
