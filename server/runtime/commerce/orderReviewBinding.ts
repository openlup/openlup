import { createHash, randomUUID } from "node:crypto";

import { OrderReviewMediaObjectStore } from "../../adapters/filesystem/orderReviewMediaObjectStore.js";
import {
  createPostgresOrderReviewAdminReadPort,
  createPostgresOrderReviewLifecyclePort,
} from "../../adapters/postgres/commerce/orderReviewLifecycle.js";
import { createPostgresOrderReviewMediaPort } from "../../adapters/postgres/commerce/orderReviewMedia.js";
import type { PgQueryExecutor } from "../../adapters/postgres/queryBuilder.js";
import { createOrderReviewAdminHandlers } from "../../domains/commerce/orderReviewAdminHandlers.js";
import { createOrderReviewHandlers } from "../../domains/commerce/orderReviewHandlers.js";
import type { OrderReviewMediaPort } from "../../domains/commerce/orderReviewPorts.js";
import {
  createOrderReviewRawUploadHandler,
  type OrderReviewRawUploadBinding,
  type OrderReviewRawUploadBindingState,
} from "../../domains/commerce/orderReviewRawUploadHandler.js";
import { getBundleDescriptor, resolveBundleId } from "../../domains/platform-runtime/platformKernel.js";
import type { OrderReviewMedia } from "../../../src/domains/commerce/orderReviewContracts.js";

type Env = Record<string, string | undefined>;
type CustomerHandlers = ReturnType<typeof createOrderReviewHandlers>;
type AdminHandlers = ReturnType<typeof createOrderReviewAdminHandlers>;

export interface AuthorizedOrderReviewMedia {
  media: OrderReviewMedia;
  open(): Promise<AsyncIterable<Uint8Array>>;
}

export interface OrderReviewRuntimeBinding {
  customer: CustomerHandlers;
  admin: AdminHandlers;
  authorizeCustomerMedia(grant: string, mediaRef: string): Promise<AuthorizedOrderReviewMedia | null>;
  authorizeAdminMedia(actorRef: string, mediaRef: string): Promise<AuthorizedOrderReviewMedia | null>;
  deleteAdminMedia(actorRef: string, mediaRef: string, idempotencyKey: string): Promise<{ replayed: boolean } | null>;
  reconcileMedia(limit?: number): Promise<number>;
  raw: OrderReviewRawUploadBinding;
  close(): Promise<void>;
}

interface DirectResources {
  executor: PgQueryExecutor;
  transaction: { run<T>(work: (executor: PgQueryExecutor) => Promise<T>): Promise<T> };
  close(): Promise<void>;
}

const bindings = new Map<string, Promise<OrderReviewRuntimeBinding>>();

export async function resolveOrderReviewRuntimeBinding(
  env: Env = process.env,
  options: { resources?: DirectResources; store?: OrderReviewMediaObjectStore } = {},
): Promise<OrderReviewRuntimeBinding | null> {
  if (getBundleDescriptor(resolveBundleId(env)).capabilities.data !== "postgres") return null;
  const connectionString = env.DATABASE_URL?.trim();
  const root = env.ORDER_REVIEW_MEDIA_ROOT?.trim();
  if (!connectionString || !root) return null;
  if (options.resources && options.store) return compose(options.resources, options.store);
  const key = `${connectionString}\u0000${root}`;
  let current = bindings.get(key);
  if (!current) {
    current = Promise.all([createResources(connectionString), OrderReviewMediaObjectStore.create(root)])
      .then(([resources, store]) => compose(resources, store));
    bindings.set(key, current);
  }
  return current;
}

export async function closeOrderReviewRuntimeBindings(): Promise<void> {
  const current = [...bindings.values()];
  bindings.clear();
  await Promise.all(current.map(async (binding) => (await binding).close()));
}

export async function resolveOrderReviewRawUploadBindingState(env: Env = process.env): Promise<OrderReviewRawUploadBindingState> {
  if (getBundleDescriptor(resolveBundleId(env)).capabilities.data !== "postgres") return { kind: "hosted" };
  const binding = await resolveOrderReviewRuntimeBinding(env);
  return binding ? { kind: "direct", binding: binding.raw } : { kind: "unbound" };
}

function compose(resources: DirectResources, store: OrderReviewMediaObjectStore): OrderReviewRuntimeBinding {
  const lifecycle = createPostgresOrderReviewLifecyclePort(resources.executor);
  const media = createPostgresOrderReviewMediaPort(resources.executor, resources.transaction);
  const customer = createOrderReviewHandlers(lifecycle);
  const admin = createOrderReviewAdminHandlers(lifecycle, createPostgresOrderReviewAdminReadPort(resources.executor));
  let closed = false;
  let reconcileInFlight: Promise<number> | null = null;
  const reconcileMedia = (limit = 25): Promise<number> => {
    if (closed) return Promise.resolve(0);
    reconcileInFlight ??= reconcileClaimedMedia(media, store, limit)
      .finally(() => { reconcileInFlight = null; });
    return reconcileInFlight;
  };
  const wakeReconciler = () => { void reconcileMedia().catch(() => undefined); };
  const interval = setInterval(wakeReconciler, 30_000);
  interval.unref?.();
  queueMicrotask(wakeReconciler);
  const open = async (object: { media: AuthorizedOrderReviewMedia["media"]; objectKey: string }) => ({
    media: object.media,
    open: () => store.open(object.objectKey),
  });
  return {
    customer,
    admin,
    async authorizeCustomerMedia(grant, mediaRef) {
      const object = await media.readAuthorized(grant, mediaRef);
      return object ? open(object) : null;
    },
    async authorizeAdminMedia(actorRef, mediaRef) {
      const object = await media.readAdmin({ actorRef, mediaRef });
      return object ? open(object) : null;
    },
    async deleteAdminMedia(actorRef, mediaRef, idempotencyKey) {
      try {
        const cleanup = await media.prepareAdminDelete({ actorRef, mediaRef, idempotencyKey });
        if (!cleanup) return null;
        await store.remove(cleanup.objectKey);
        if (cleanup.tempKey) await store.remove(cleanup.tempKey);
        const finalState = await store.inspect(cleanup.objectKey);
        const tempState = cleanup.tempKey ? await store.inspect(cleanup.tempKey) : { exists: false };
        if (finalState.exists || tempState.exists) throw new Error("order_review_media_cleanup_incomplete");
        const completed = await media.completeAdminDelete({ actorRef, cleanupReceipt: cleanup.cleanupReceipt });
        return { replayed: cleanup.replayed || completed.replayed };
      } catch (error) {
        wakeReconciler();
        throw error;
      }
    },
    reconcileMedia,
    raw: {
      async admit(input) {
        const writerRef = randomUUID();
        const admission = await media.admitUpload({
          capabilityDigest: input.capabilityDigest,
          declaredContentType: input.declaredMime,
          declaredByteLength: input.declaredBytes,
          writerRef,
        });
        if (admission.kind === "unavailable") return { kind: "refused", status: 404, code: "ORDER_REVIEW_MEDIA_NOT_FOUND" };
        if (admission.kind === "conflict") return { kind: "refused", status: 409, code: "ORDER_REVIEW_MEDIA_CONFLICT" };
        if (admission.kind === "complete") {
          return { async upload({ body }) {
            const hash = createHash("sha256");
            for await (const chunk of body) hash.update(chunk);
            return hash.digest("hex") === admission.media.observedDigest
              ? { kind: "complete", status: 200, mediaRef: admission.media.mediaRef } as const
              : { kind: "refused", status: 409, code: "ORDER_REVIEW_MEDIA_CONFLICT" } as const;
          } };
        }
        const reservation = admission.reservation;
        return {
          async upload({ body }) {
            let tempRef: string | undefined;
            let promoted = false;
            try {
              const receipt = await store.writeTemp(
                writerRef, body, reservation.declaredByteLength, reservation.leaseExpiresAt,
              );
              tempRef = receipt.tempRef;
              const finalized = await media.finalizeUpload({
                capabilityDigest: input.capabilityDigest,
                writerRef,
                leaseVersion: reservation.leaseVersion,
                digest: receipt.sha256,
                byteLength: receipt.bytes,
                promote: async () => { await store.promote(receipt.tempRef, reservation.objectKey); promoted = true; },
              });
              if (!finalized) {
                await store.remove(receipt.tempRef).catch(() => false);
                return { kind: "refused", status: 409, code: "ORDER_REVIEW_MEDIA_CONFLICT" } as const;
              }
              return { kind: "complete", status: finalized.state === "stored" ? 201 : 200, mediaRef: finalized.mediaRef } as const;
            } catch (error) {
              if (!promoted) {
                let reason = "object_absent";
                if (tempRef) {
                  await store.remove(tempRef).catch(() => false);
                  const state = await store.inspect(tempRef, reservation.declaredByteLength).catch(() => ({ exists: true } as const));
                  if (state.exists) reason = "upload_residue";
                }
                await media.abortUpload({
                  capabilityDigest: input.capabilityDigest,
                  writerRef,
                  leaseVersion: reservation.leaseVersion,
                  reason,
                }).catch(() => undefined);
              }
              wakeReconciler();
              throw error;
            }
          },
        };
      },
    },
    async close() {
      closed = true;
      clearInterval(interval);
      await reconcileInFlight?.catch(() => undefined);
      await resources.close();
    },
  };
}

async function reconcileClaimedMedia(
  media: OrderReviewMediaPort,
  store: OrderReviewMediaObjectStore,
  limit: number,
): Promise<number> {
  const tasks = await media.claimReconcile(limit);
  for (const task of tasks) {
    try {
      if (task.kind === "delete") {
        await store.remove(task.objectKey);
        if (task.tempKey) await store.remove(task.tempKey);
        const finalState = await store.inspect(task.objectKey, task.expectedDeclaredByteLength);
        const tempState = task.tempKey ? await store.inspect(task.tempKey, task.expectedDeclaredByteLength) : { exists: false };
        await media.completeReconcile({ receipt: task.receipt,
          outcome: finalState.exists || tempState.exists ? { kind: "retry", reason: "object_remains" } : { kind: "deleted" } });
        continue;
      }
      let inspection = await store.inspect(task.objectKey, task.expectedDeclaredByteLength);
      let temporaryExists = false;
      if (!inspection.exists && task.tempKey) {
        const temporary = await store.inspect(task.tempKey, task.expectedDeclaredByteLength);
        temporaryExists = temporary.exists;
        if (temporary.exists && temporary.bytes === task.expectedDeclaredByteLength) {
          await store.promote(task.tempKey, task.objectKey);
          inspection = await store.inspect(task.objectKey, task.expectedDeclaredByteLength);
        }
      }
      await media.completeReconcile({ receipt: task.receipt,
        outcome: inspection.exists && inspection.bytes === task.expectedDeclaredByteLength && inspection.sha256
          ? { kind: "stored", observedContentType: task.expectedDeclaredContentType,
              observedByteLength: inspection.bytes, observedDigest: inspection.sha256 }
          : { kind: "retry", reason: !inspection.exists && !temporaryExists ? "object_absent" : "object_mismatch" } });
    } catch {
      await media.completeReconcile({ receipt: task.receipt, outcome: { kind: "retry", reason: "object_io_failed" } });
    }
  }
  return tasks.length;
}

async function createResources(connectionString: string): Promise<DirectResources> {
  const pg = await import("pg");
  const PoolCtor = (pg.default?.Pool ?? pg.Pool) as typeof import("pg").Pool;
  const pool = new PoolCtor({ connectionString });
  return {
    executor: { query: (sql, values) => pool.query(sql, values) },
    transaction: {
      async run<T>(work: (executor: PgQueryExecutor) => Promise<T>): Promise<T> {
        const client = await pool.connect();
        try {
          await client.query("BEGIN");
          const value = await work(client);
          await client.query("COMMIT");
          return value;
        } catch (error) {
          await client.query("ROLLBACK").catch(() => undefined);
          throw error;
        } finally {
          client.release();
        }
      },
    },
    close: () => pool.end(),
  };
}

export default createOrderReviewRawUploadHandler({ resolveBinding: resolveOrderReviewRawUploadBindingState });
