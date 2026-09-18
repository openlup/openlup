import type {
  ShipmentSpineMutationPort,
  ShipmentSpineResult,
} from "../../../src/domains/fulfillment/commerceFulfillmentPorts.js";
import {
  CommerceFulfillmentConflictError,
  CommerceFulfillmentPersistenceError,
} from "../../../src/domains/fulfillment/commerceFulfillmentPorts.js";
import type {
  OrderPaidFulfillmentPort,
  OrderPaidFulfillmentResult,
} from "../../domains/commerce/outboxOrderPaidFulfillmentPorts.js";
import {
  createPostgresFulfillmentTransactionLane,
  type PostgresFulfillmentTransactionLane,
} from "../../adapters/postgres/dataGateway.js";
import { createPostgresFulfillmentShipmentSpinePort } from "../../adapters/postgres/fulfillmentShipmentSpine.js";
import type { PgQueryExecutor } from "../../adapters/postgres/queryBuilder.js";
import { createSupabaseFulfillmentShipmentSpinePort } from "../../adapters/supabase/fulfillmentCompositionPorts.js";
import { resolveBundleId } from "../../domains/platform-runtime/platformKernel.js";

export type ShipmentSpineBindingEnv = Record<string, string | undefined>;

export type ShipmentSpineBinding = ShipmentSpineMutationPort & {
  close(): Promise<void>;
};

export type ShipmentSpineBindingResolution =
  | { readonly binding: ShipmentSpineBinding; readonly error?: undefined }
  | {
      readonly binding?: undefined;
      readonly error:
        | "database_url_required"
        | "fulfillment_port_key_required"
        | "fulfillment_managed_client_required"
        | "fulfillment_provider_kind_required";
    };

type PostgresFactory = typeof createPostgresFulfillmentShipmentSpinePort;
type ManagedFactory = typeof createSupabaseFulfillmentShipmentSpinePort;

export interface ShipmentSpineBindingOptions {
  /** Request-scoped RPC client supplied by the managed composition root. */
  managedClient?: Parameters<ManagedFactory>[0];
  /** Managed provider identity read by composition; never inferred in the adapter. */
  providerKind?: string;
  /** Opaque public-platform registry key. Overrides FULFILLMENT_PORT_KEY. */
  portKey?: string;
  /** Optional fail-closed archetype guard for automatic order-paid execution. */
  requiredProviderType?: "simulator";
  createManagedPort?: ManagedFactory;
  createPostgresPort?: PostgresFactory;
  createPostgresLane?: (connectionString: string) => PostgresFulfillmentTransactionLane;
  resolveBundle?: typeof resolveBundleId;
}

/**
 * Resolve the shipped shipment-spine capability without exposing a generic
 * query client. Configuration failures are named refusals and construct no
 * adapter, pool, or placeholder implementation.
 */
export function resolveShipmentSpineBinding(
  env: ShipmentSpineBindingEnv = process.env,
  options: ShipmentSpineBindingOptions = {},
): ShipmentSpineBindingResolution {
  const bundle = (options.resolveBundle ?? resolveBundleId)(env);

  if (bundle === "node-postgres") {
    const connectionString = env.DATABASE_URL?.trim() ?? "";
    if (!connectionString) return { error: "database_url_required" };

    const portKey = options.portKey?.trim() || env.FULFILLMENT_PORT_KEY?.trim() || "";
    if (!portKey) return { error: "fulfillment_port_key_required" };

    const lane = (options.createPostgresLane
      ?? ((value) => createPostgresFulfillmentTransactionLane({ connectionString: value })))(connectionString);
    const createPort = options.createPostgresPort ?? createPostgresFulfillmentShipmentSpinePort;

    return { binding: bindPostgresLane(lane, createPort, {
      portKey,
      requiredProviderType: options.requiredProviderType,
    }) };
  }

  if (!options.managedClient) return { error: "fulfillment_managed_client_required" };
  const providerKind = options.providerKind?.trim() ?? "";
  if (!providerKind) return { error: "fulfillment_provider_kind_required" };

  const port = (options.createManagedPort ?? createSupabaseFulfillmentShipmentSpinePort)(
    options.managedClient,
    { providerKind },
  );
  return { binding: { ...port, close: async () => {} } };
}

function bindPostgresLane(
  lane: PostgresFulfillmentTransactionLane,
  createPort: PostgresFactory,
  adapterOptions: Parameters<PostgresFactory>[1],
): ShipmentSpineBinding {
  const run = <K extends keyof ShipmentSpineMutationPort>(
    method: K,
    request: Parameters<ShipmentSpineMutationPort[K]>[0],
  ): Promise<ShipmentSpineResult> => lane.run((client) => {
    const port = createPort(asExecutor(client), adapterOptions);
    const operation = port[method] as (input: typeof request) => Promise<ShipmentSpineResult>;
    return operation(request);
  });

  return {
    createShipment: (request) => run("createShipment", request),
    recordLabel: (request) => run("recordLabel", request),
    handOff: (request) => run("handOff", request),
    recordTracking: (request) => run("recordTracking", request),
    cancel: (request) => run("cancel", request),
    raiseException: (request) => run("raiseException", request),
    close: lane.close,
  };
}

function asExecutor(client: unknown): PgQueryExecutor {
  if (!client || typeof (client as { query?: unknown }).query !== "function") {
    throw new Error("fulfillment_postgres_executor_required");
  }
  return client as PgQueryExecutor;
}

/** Order-paid adopter for a binding already restricted to the simulator archetype. */
export type CloseableOrderPaidFulfillmentPort = OrderPaidFulfillmentPort & {
  close(): Promise<void>;
};

export function createOrderPaidShipmentSpinePort(spine: ShipmentSpineBinding): CloseableOrderPaidFulfillmentPort {
  return {
    async ensureFulfilledFromPaidOrder({ orderUuid, signal }) {
      const key = (suffix: string): string => `order-paid-dispatch:${orderUuid}:${suffix}`;
      const aborted = (): OrderPaidFulfillmentResult => ({ kind: "retryable", reason: "outbox_handler_timeout" });
      try {
        if (signal.aborted) return aborted();
        const created = await spine.createShipment({
          idempotencyKey: key("create"), orderId: orderUuid, metadata: { source: "order-paid-dispatch" },
        });
        if (signal.aborted) return aborted();
        const labelled = await spine.recordLabel({
          idempotencyKey: key("label"), shipmentId: created.shipmentId, metadata: { source: "order-paid-dispatch" },
        });
        if (signal.aborted) return aborted();
        const handedOver = await spine.handOff({
          idempotencyKey: key("handoff"), shipmentId: created.shipmentId, metadata: { source: "order-paid-dispatch" },
        });
        return { kind: "completed", detail: {
          fulfillmentOrderId: handedOver.shipmentId,
          status: handedOver.status,
          replayed: handedOver.replayed || labelled.replayed,
        } };
      } catch (error) {
        if (error instanceof CommerceFulfillmentConflictError) return {
          kind: error.message === "fulfillment_port_not_ready" ? "snooze" : "fatal",
          reason: error.message,
        };
        if (error instanceof CommerceFulfillmentPersistenceError) {
          return { kind: "retryable", reason: error.message };
        }
        return { kind: "retryable", reason: "fulfillment_spine_failed" };
      }
    },
    close: spine.close,
  };
}

/** Close an optional batch-scoped resource without widening the domain port. */
export async function closeOrderPaidShipmentSpinePort(
  port: OrderPaidFulfillmentPort | undefined,
): Promise<void> {
  const close = (port as Partial<CloseableOrderPaidFulfillmentPort> | undefined)?.close;
  if (typeof close === "function") await close();
}
