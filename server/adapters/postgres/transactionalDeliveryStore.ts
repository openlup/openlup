import { createPostgresTransactionalDeliveryStore as createStore } from "@openlup/platform/communications";
import { createPostgresTransactionalDeliveryTransactionLane, type PostgresDataGatewayEnv, type PostgresDataGatewayOptions } from "./dataGateway.js";
export type { PostgresTransactionalDeliveryStore } from "@openlup/platform/communications";
export function createPostgresTransactionalDeliveryStore(env: PostgresDataGatewayEnv, options: PostgresDataGatewayOptions = {}) {
  return createStore(env, options, createPostgresTransactionalDeliveryTransactionLane);
}
