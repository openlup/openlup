import { createCapturedTransactionalDelivery } from "../../adapters/captured/transactionalDelivery.js";
import {
  createPostgresTransactionalDeliveryStore,
  type PostgresTransactionalDeliveryStore,
} from "../../adapters/postgres/transactionalDeliveryStore.js";
import {
  createReceiptFixtureScope as createManagedFixtureScope,
  createManagedReceiptStoreScope,
  type ManagedReceiptStoreScope,
  type ReceiptFixtureScope,
} from "../../adapters/supabase/transactionalDeliveryStore.js";
import {
  TransactionalDeliveryConflictError,
  TransactionalDeliveryUnavailableError,
  TransactionalDeliveryValidationError,
  createTransactionalDelivery,
} from "../../domains/communications/transactionalDelivery.js";
import {
  DEFAULT_PLATFORM_BUNDLE,
  getBundleDescriptor,
  resolveBundleId,
} from "../../domains/platform-runtime/platformKernel.js";
import type {
  CapturedTransactionalDeliveryPort,
  TransactionalDeliveryCommand,
  TransactionalDeliveryReceipt,
} from "../../../src/domains/communications/transactionalDeliveryPort.js";
import type { TransactionalRuntimePort } from "../../../src/domains/platform-runtime/ports.js";

type Env = Record<string, string | undefined>;
export type TransactionalDeliveryAction = {
  send(command: TransactionalDeliveryCommand): Promise<TransactionalDeliveryReceipt>;
  readReceipt(idempotencyKey: string): Promise<TransactionalDeliveryReceipt | null>;
};
export interface TransactionalDeliveryBinding {
  readonly identity: string;
  run<T>(work: (delivery: TransactionalDeliveryAction) => Promise<T>): Promise<T>;
}

export type TransactionalDeliveryBindingResolution =
  | { readonly binding: TransactionalDeliveryBinding; readonly error?: undefined }
  | { readonly binding?: undefined; readonly error: string };

export interface TransactionalDeliveryBindingOptions {
  capturedFactory?: () => CapturedTransactionalDeliveryPort;
  postgresStoreFactory?: (connectionString: string) => PostgresTransactionalDeliveryStore;
  managedScopeFactory?: (env: Env) => ManagedReceiptStoreScope | null;
}

function action(store: Parameters<typeof createTransactionalDelivery>[0]["store"], capturedFactory: () => CapturedTransactionalDeliveryPort): TransactionalDeliveryAction {
  return { ...createTransactionalDelivery({ store, delivery: capturedFactory() }), readReceipt: store.readReceipt.bind(store) };
}

/** Bind the receipt capability without exposing a generic gateway or raw client. */
export function resolveTransactionalDeliveryBinding(
  env: Env,
  options: TransactionalDeliveryBindingOptions = {},
): TransactionalDeliveryBindingResolution {
  const bundleId = resolveBundleId(env);
  const capturedFactory = options.capturedFactory ?? createCapturedTransactionalDelivery;
  if (bundleId === "node-postgres") {
    const connectionString = env.DATABASE_URL?.trim() ?? "";
    if (!connectionString) return { error: "database_url_required" };
    const factory = options.postgresStoreFactory
      ?? ((url) => createPostgresTransactionalDeliveryStore({ connectionString: url }));
    return {
      binding: {
        identity: "node-postgres",
        async run(work) {
          const store = factory(connectionString);
          try {
            return await work(action(store, capturedFactory));
          } finally {
            await store.close();
          }
        },
      },
    };
  }
  if (bundleId !== DEFAULT_PLATFORM_BUNDLE) return { error: "transactional_delivery_bundle_unbound" };
  const scope = (options.managedScopeFactory ?? createManagedReceiptStoreScope)(env);
  if (!scope) return { error: "managed_receipt_store_unavailable" };
  return {
    binding: {
      identity: bundleId,
      run: (work) => scope.run((store) => work(action(store, capturedFactory))),
    },
  };
}

function requestCommand(value: unknown): TransactionalDeliveryCommand | null {
  if (!value || typeof value !== "object") return null;
  const input = value as Record<string, unknown>;
  return typeof input.idempotencyKey === "string"
    && typeof input.recipientReference === "string"
    && typeof input.templateReference === "string"
    ? {
        idempotencyKey: input.idempotencyKey,
        recipientReference: input.recipientReference,
        templateReference: input.templateReference,
        ...(typeof input.accessGrantReference === "string"
          ? { accessGrantReference: input.accessGrantReference } : {}),
      }
    : null;
}

function nodeHandler(env: Env, options: TransactionalDeliveryBindingOptions): EdgeFunctionHandler {
  return async (request) => {
    let command: TransactionalDeliveryCommand | null = null;
    try { command = requestCommand(await request.json()); } catch { /* return bad request below */ }
    if (!command) return new Response(null, { status: 400 });
    const resolved = resolveTransactionalDeliveryBinding(env, options);
    if (!resolved.binding) return new Response(null, { status: 500 });
    try {
      await resolved.binding.run((delivery) => delivery.send(command!));
      return new Response(null, { status: 202 });
    } catch (error) {
      if (error instanceof TransactionalDeliveryValidationError) return new Response(null, { status: 400 });
      if (error instanceof TransactionalDeliveryConflictError) return new Response(null, { status: 409 });
      if (error instanceof TransactionalDeliveryUnavailableError) return new Response(null, { status: 503 });
      return new Response(null, { status: 500 });
    }
  };
}

type EdgeFunctionHandler = (request: Request) => Promise<Response>;

function createBoundNodeRuntime(handler: EdgeFunctionHandler): TransactionalRuntimePort {
  return {
    async invoke(functionName, payload) {
      if (functionName !== "send-email") return { ok: false, status: 404 };
      try {
        const response = await handler(new Request("http://localhost/internal/transactional-delivery", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(payload ?? {}),
        }));
        return { ok: response.status >= 200 && response.status < 400, status: response.status };
      } catch {
        return { ok: false, status: 500 };
      }
    },
  };
}

/** The parity harness receives only its capability-specific managed fixture scope. */
export function createTransactionalDeliveryFixtureScope(env: Env): ReceiptFixtureScope {
  return createManagedFixtureScope(env);
}

/** Node-postgres completes only direct send-email; every other Node action stays unknown. */
export function createNodePostgresTransactionalRuntime(
  env: Env,
  options: TransactionalDeliveryBindingOptions = {},
): TransactionalRuntimePort {
  if (getBundleDescriptor(resolveBundleId(env)).capabilities.data !== "postgres") {
    throw new Error("transactional_delivery_postgres_binding_required");
  }
  return createBoundNodeRuntime(nodeHandler(env, options));
}
