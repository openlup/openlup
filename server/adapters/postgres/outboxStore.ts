import { createPostgresOutboxStore as createPackagePostgresOutboxStore } from "@openlup/outbox/postgres";
import {
  createPostgresOutboxTransactionLane,
  type PostgresDataGatewayEnv,
  type PostgresDataGatewayOptions,
} from "./dataGateway.js";
import type { OutboxStore } from "../../domains/commerce/outboxDispatchContracts.js";

interface PostgresOutboxQueryClient {
  query<Row extends Record<string, unknown> = Record<string, unknown>>(
    text: string,
    values?: readonly unknown[],
  ): Promise<{ rows: Row[] }>;
}

/** Direct-Postgres adapter over the authored, four-operation outbox rail. */
export interface PostgresOutboxStore extends OutboxStore {
  close(): Promise<void>;
}

export function createPostgresOutboxStore(
  env: PostgresDataGatewayEnv,
  options: PostgresDataGatewayOptions = {},
): PostgresOutboxStore {
  const transactions = createPostgresOutboxTransactionLane(env, options);
  const store = createPackagePostgresOutboxStore({
    query: <Row extends Record<string, unknown> = Record<string, unknown>>(
      text: string,
      values?: readonly unknown[],
    ) => transactions.run((client) => (client as PostgresOutboxQueryClient).query<Row>(text, values ? [...values] : undefined)),
  });

  return {
    ...store,
    close: () => transactions.close(),
  };
}
