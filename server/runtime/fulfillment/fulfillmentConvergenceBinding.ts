import type { OmnipackStockSyncPort } from "../../domains/fulfillment/omnipackStockSyncContracts.js";
import type { FulfillmentLowStockEvidencePort } from "../../../src/domains/fulfillment/ports.js";
import {
  createPostgresFulfillmentTransactionLane,
  type PostgresFulfillmentTransactionLane,
} from "../../adapters/postgres/dataGateway.js";
import { createPostgresFulfillmentStockSyncPort } from "../../adapters/postgres/fulfillmentStockSyncPort.js";
import { createPostgresFulfillmentLowStockEvidencePort } from "../../adapters/postgres/fulfillmentEvidenceReadPort.js";
import type { PgQueryExecutor } from "../../adapters/postgres/queryBuilder.js";
import {
  createSupabaseOmnipackStockSyncPort,
  type OmnipackStockSyncSupabaseClient,
} from "../../adapters/supabase/omnipackStockSyncPort.js";
import {
  createSupabaseLowStockEvidencePort,
  type FulfillmentEvidenceSupabaseClient,
} from "../../adapters/supabase/fulfillmentEvidencePorts.js";
import { resolveBundleId } from "../../domains/platform-runtime/platformKernel.js";

type Env = Record<string, string | undefined>;
export type CloseableFulfillmentStockSyncPort = OmnipackStockSyncPort & { close(): Promise<void> };
export interface FulfillmentEvidenceBinding {
  run<T>(work: (port: FulfillmentLowStockEvidencePort) => Promise<T>): Promise<T>;
}

export function resolveFulfillmentStockSyncBinding(
  env: Env,
  options: {
    managedClient?: OmnipackStockSyncSupabaseClient;
    sourceKey?: string;
    inventoryClasses?: ReadonlyMap<string, "sellable" | "packaging">;
    createLane?: (connectionString: string) => PostgresFulfillmentTransactionLane;
  } = {},
): { binding: CloseableFulfillmentStockSyncPort; error?: undefined } | { binding?: undefined; error: string } {
  if (resolveBundleId(env) !== "node-postgres") {
    if (!options.managedClient) return { error: "fulfillment_managed_client_required" };
    const port = createSupabaseOmnipackStockSyncPort(options.managedClient, {
      inventoryClasses: options.inventoryClasses,
    });
    return { binding: { ...port, close: async () => {} } };
  }

  const connectionString = env.DATABASE_URL?.trim() ?? "";
  if (!connectionString) return { error: "database_url_required" };
  const sourceKey = options.sourceKey?.trim() || env.FULFILLMENT_STOCK_SOURCE_KEY?.trim() || "";
  if (!sourceKey) return { error: "fulfillment_stock_source_key_required" };
  const lane = (options.createLane ?? ((value) => createPostgresFulfillmentTransactionLane({
    connectionString: value,
  })))(connectionString);
  return { binding: bindDirect(lane, sourceKey, options.inventoryClasses) };
}

export function resolveFulfillmentEvidenceBinding(
  env: Env,
  options: { managedClient?: FulfillmentEvidenceSupabaseClient; sourceKey?: string } = {},
): { binding: FulfillmentEvidenceBinding; error?: undefined } | { binding?: undefined; error: string } {
  if (resolveBundleId(env) !== "node-postgres") {
    if (!options.managedClient) return { error: "fulfillment_managed_client_required" };
    return { binding: { run: (work) => work(createSupabaseLowStockEvidencePort(options.managedClient!)) } };
  }
  const connectionString = env.DATABASE_URL?.trim() ?? "";
  if (!connectionString) return { error: "database_url_required" };
  const sourceKey = options.sourceKey?.trim() || env.FULFILLMENT_STOCK_SOURCE_KEY?.trim() || "";
  if (!sourceKey) return { error: "fulfillment_stock_source_key_required" };
  return { binding: { async run(work) {
    const lane = createPostgresFulfillmentTransactionLane({ connectionString });
    try {
      return await lane.run((client) => work(createPostgresFulfillmentLowStockEvidencePort(
        client as PgQueryExecutor, sourceKey,
      )));
    } finally { await lane.close(); }
  } } };
}

function bindDirect(
  lane: PostgresFulfillmentTransactionLane,
  sourceKey: string,
  inventoryClasses?: ReadonlyMap<string, "sellable" | "packaging">,
): CloseableFulfillmentStockSyncPort {
  const run = <T>(work: (port: OmnipackStockSyncPort) => Promise<T>): Promise<T> => lane.run((client) =>
    work(createPostgresFulfillmentStockSyncPort(client as PgQueryExecutor, { sourceKey, inventoryClasses })));
  return {
    readCursor: () => run((port) => port.readCursor()),
    readLocalInventoryStock: () => run((port) => port.readLocalInventoryStock()),
    readSkuInventoryClasses: (skus) => run((port) => port.readSkuInventoryClasses(skus)),
    readActiveReservations: (skus, requestedAt) => run((port) => port.readActiveReservations(skus, requestedAt)),
    recordCursor: (input) => run((port) => port.recordCursor(input)),
    recordStockSnapshot: (input) => run((port) => port.recordStockSnapshot(input)),
    recordProviderStockCurrent: (input) => run((port) => port.recordProviderStockCurrent(input)),
    recordLowStockEvidence: (input) => run((port) => port.recordLowStockEvidence(input)),
    resolveLowStockEvidence: (input) => run((port) => port.resolveLowStockEvidence(input)),
    close: lane.close,
  };
}
