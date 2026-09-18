import type {
  TransactionalDeliveryReceipt,
  TransactionalDeliveryReceiptStore,
} from "../../../src/domains/communications/transactionalDeliveryPort.js";
import { DEFAULT_PLATFORM_BUNDLE } from "../../../src/domains/platform-runtime/contracts.js";
import { createSupabaseDataGateway as createGateway } from "./dataGateway.js";
import {
  createServiceClient as createClient,
  readSupabaseDataGatewayEnv as readGatewayEnv,
} from "./dataGatewayClientFactory.js";

type Env = Record<string, string | undefined>;
type GatewayEnv = NonNullable<ReturnType<typeof readGatewayEnv>>;
type ReceiptScopeGateway = { asService<T>(work: (client: unknown) => Promise<T>): Promise<T> };
type ReceiptFixtureClient = { from(table: string): { delete(): { eq(column: string, value: string): Promise<{ error: unknown }> }; select(columns: string): { eq(column: string, value: string): Promise<{ data: unknown; error: unknown }> } } };

export interface ManagedTransactionalDeliveryStoreClient {
  rpc(
    functionName: string,
    args: Record<string, unknown>,
  ): PromiseLike<{ data: unknown; error: { code?: string; message?: string } | null }>;
}

export interface ManagedReceiptStoreScope {
  run<T>(work: (store: TransactionalDeliveryReceiptStore) => Promise<T>): Promise<T>;
}

export interface ManagedReceiptStoreScopeOptions {
  gatewayFactory?: (env: GatewayEnv) => ReceiptScopeGateway;
  fixtureClientFactory?: (env: GatewayEnv) => ReceiptFixtureClient;
}

export interface ReceiptFixtureScope {
  readonly env: Env;
  cleanupReceipt(idempotencyKey: string): Promise<void>;
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

/** Managed adapter over the three receipt RPCs; access scope belongs to its binding. */
export function createManagedTransactionalDeliveryStore(
  client: ManagedTransactionalDeliveryStoreClient,
): TransactionalDeliveryReceiptStore {
  const call = async (name: string, args: Record<string, unknown>): Promise<TransactionalDeliveryReceipt> => {
    const { data, error } = await client.rpc(name, args);
    if (error) throw failure(name, error);
    return receipt(data);
  };
  return {
    async readReceipt(idempotencyKey) {
      const { data, error } = await client.rpc("transactional_delivery_read_receipt", { p_idempotency_key: idempotencyKey });
      if (error) throw failure("transactional_delivery_read_receipt", error);
      return Array.isArray(data) && data.length === 0 ? null : receipt(data);
    },
    recordAccepted: (input) => call("transactional_delivery_record_accepted", {
      p_idempotency_key: input.idempotencyKey,
      p_command_fingerprint: input.commandFingerprint,
      p_delivery_reference: input.deliveryReference,
    }),
    recordFailed: (input) => call("transactional_delivery_record_failed", {
      p_idempotency_key: input.idempotencyKey,
      p_command_fingerprint: input.commandFingerprint,
      p_error_code: input.errorCode,
    }),
  };
}

/** Keeps managed access construction inside the concrete receipt adapter boundary. */
export function createManagedReceiptStoreScope(
  env: Env,
  options: ManagedReceiptStoreScopeOptions = {},
): ManagedReceiptStoreScope | null {
  const gatewayEnv = readGatewayEnv(env);
  if (!gatewayEnv) return null;
  const gateway = (options.gatewayFactory ?? createGateway)(gatewayEnv);
  return {
    run: (work) => gateway.asService((client) => work(createManagedTransactionalDeliveryStore(client as ManagedTransactionalDeliveryStoreClient))),
  };
}

/** Managed-harness fixture cleanup stays narrow: one namespaced receipt and residual-zero readback. */
export function createReceiptFixtureScope(
  env: Env,
  options: Pick<ManagedReceiptStoreScopeOptions, "fixtureClientFactory"> = {},
): ReceiptFixtureScope {
  const gatewayEnv = readGatewayEnv(env);
  const projectRef = env.MANAGED_DB_PROJECT_REF?.trim() ?? "";
  if (!gatewayEnv || !projectRef || new URL(gatewayEnv.url).hostname !== `${projectRef}.supabase.co`) {
    throw new Error("managed transactional delivery requires the canonical staging project");
  }
  const client = (options.fixtureClientFactory ?? createClient)(gatewayEnv) as ReceiptFixtureClient;
  return {
    env: { ...env, PLATFORM_BUNDLE: DEFAULT_PLATFORM_BUNDLE },
    async cleanupReceipt(idempotencyKey) {
      if (!/^delivery-parity:[a-f0-9]{48}$/.test(idempotencyKey)) {
        throw new Error("managed transactional delivery cleanup key is outside the parity namespace");
      }
      const deleted = await client.from("transactional_delivery_receipts").delete().eq("idempotency_key", idempotencyKey);
      if (deleted.error) throw new Error("managed transactional delivery cleanup failed");
      const residual = await client.from("transactional_delivery_receipts").select("idempotency_key").eq("idempotency_key", idempotencyKey);
      if (residual.error || !Array.isArray(residual.data) || residual.data.length !== 0) {
        throw new Error("managed transactional delivery cleanup left a residual receipt");
      }
    },
  };
}
