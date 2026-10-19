import { createManagedTransactionalDeliveryStore } from "@openlup/platform/communications";
import type { ManagedTransactionalDeliveryStoreClient } from "@openlup/platform/communications";
export { createManagedTransactionalDeliveryStore } from "@openlup/platform/communications";
export type { ManagedTransactionalDeliveryStoreClient } from "@openlup/platform/communications";
import type {
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
