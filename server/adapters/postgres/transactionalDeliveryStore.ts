import {
  createPostgresTransactionalDeliveryTransactionLane,
  type PostgresDataGatewayEnv,
  type PostgresDataGatewayOptions,
} from "./dataGateway.js";
import type {
  TransactionalDeliveryReceipt,
  TransactionalDeliveryReceiptStore,
} from "../../../src/domains/communications/transactionalDeliveryPort.js";

interface PostgresTransactionalDeliveryStoreClient {
  rpc(name: string, args: Record<string, unknown>): PromiseLike<{
    data: unknown;
    error: { code?: string; message?: string } | null;
  }>;
}

export interface PostgresTransactionalDeliveryStore extends TransactionalDeliveryReceiptStore {
  close(): Promise<void>;
}

function failure(name: string, error: { code?: string; message?: string }): Error & { code?: string } {
  const result = new Error(`${name}_failed: ${error.message ?? error.code ?? "unknown"}`) as Error & { code?: string };
  result.code = error.code;
  return result;
}

function receipt(data: unknown): TransactionalDeliveryReceipt {
  const value = (Array.isArray(data) ? data[0] : data) as Record<string, unknown> | undefined;
  if (!value || typeof value !== "object") throw new Error("transactional_delivery_receipt_invalid");
  const common = {
    idempotencyKey: String(value.idempotency_key ?? ""),
    commandFingerprint: String(value.command_fingerprint ?? ""),
    attemptCount: Number(value.attempt_count ?? 0),
  };
  if (value.state === "accepted" && typeof value.delivery_reference === "string" && value.error_code == null) {
    return { ...common, state: "accepted", deliveryReference: value.delivery_reference, errorCode: null };
  }
  if (value.state === "failed" && value.delivery_reference == null && typeof value.error_code === "string") {
    return { ...common, state: "failed", deliveryReference: null, errorCode: value.error_code };
  }
  throw new Error("transactional_delivery_receipt_invalid");
}

/** Direct-Postgres receipt adapter: one role-free transaction for each store operation. */
export function createPostgresTransactionalDeliveryStore(
  env: PostgresDataGatewayEnv,
  options: PostgresDataGatewayOptions = {},
): PostgresTransactionalDeliveryStore {
  const transactions = createPostgresTransactionalDeliveryTransactionLane(env, options);
  const call = <T>(work: (client: PostgresTransactionalDeliveryStoreClient) => Promise<T>): Promise<T> =>
    transactions.run((client) => work(client as PostgresTransactionalDeliveryStoreClient));
  const write = (name: string, args: Record<string, unknown>) => call(async (client) => {
    const { data, error } = await client.rpc(name, args);
    if (error) throw failure(name, error);
    return receipt(data);
  });
  return {
    async readReceipt(idempotencyKey) {
      return call(async (client) => {
        const { data, error } = await client.rpc("transactional_delivery_read_receipt", { p_idempotency_key: idempotencyKey });
        if (error) throw failure("transactional_delivery_read_receipt", error);
        return Array.isArray(data) && data.length === 0 ? null : receipt(data);
      });
    },
    recordAccepted: (input) => write("transactional_delivery_record_accepted", {
      p_idempotency_key: input.idempotencyKey,
      p_command_fingerprint: input.commandFingerprint,
      p_delivery_reference: input.deliveryReference,
    }),
    recordFailed: (input) => write("transactional_delivery_record_failed", {
      p_idempotency_key: input.idempotencyKey,
      p_command_fingerprint: input.commandFingerprint,
      p_error_code: input.errorCode,
    }),
    close: () => transactions.close(),
  };
}
