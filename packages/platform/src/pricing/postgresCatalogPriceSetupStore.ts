import { createHash } from "node:crypto";
import { canonicalCatalogPriceSetupCommand } from "./catalogPriceSetupSchemas.js";
import type { CatalogPriceSetupCommand } from "./contracts/catalogPriceSetup.js";
import { catalogPriceSetupApplyResultSchema, catalogPriceSetupPreviewResultSchema, catalogPriceSetupReasonsSchema } from "./catalogPriceSetupSchemas.js";
import type { CatalogPriceSetupRefusal } from "./contracts/catalogPriceSetup.js";
import type { CatalogPriceSetupStorePort } from "./catalogPriceSetupHandler.js";

/** The authenticated transaction's executor; publication may use its own connection.
 * @experimental
 */
export interface CatalogPriceSetupQueryExecutor {
  query(sql: string, values?: unknown[]): Promise<{ rows: Record<string, unknown>[] }>;
}

/** Session-bound SQL authority derives the actor; composition verifies the session.
 * @experimental
 */
export function createPostgresCatalogPriceSetupStore(client: CatalogPriceSetupQueryExecutor): CatalogPriceSetupStorePort {
  async function call(sql: string, values: unknown[], schema: typeof catalogPriceSetupApplyResultSchema | typeof catalogPriceSetupPreviewResultSchema) {
    try {
      const result = await client.query(sql, values);
      const parsed = schema.safeParse(result.rows.length === 1 ? result.rows[0]?.result : undefined);
      return parsed.success ? parsed.data : { outcome: "dependency_unavailable" as const, reason: "invalid_store_response" };
    } catch (error) { return catalogPriceSetupRefusal(error); }
  }
  return {
    preview: query => call("SELECT public.catalog_price_setup_preview($1::uuid,$2::uuid,$3::integer) AS result",
      [query.variantId, query.priceListId, query.unitPriceMinor ?? null], catalogPriceSetupPreviewResultSchema),
    apply: input => call("SELECT public.catalog_price_setup_apply($1::text,$2::text) AS result",
      [input.canonicalCommand, input.fingerprint], catalogPriceSetupApplyResultSchema),
  };
}

/** Explicit whitelist: arbitrary database text never reaches a caller.
 * @experimental
 */
export const CATALOG_PRICE_SETUP_HARD_REFUSALS = [
  "native_promotion_unverified", "native_cohort_unverified", "native_order_unverified", "native_agreement_unverified",
  "settlement_context_unverified", "native_promotion_domain_unverified", "native_price_domain_unverified",
  "native_catalog_domain_unverified", "native_policy_domain_unverified", "native_agreement_domain_unverified",
  "native_job_domain_unverified", "native_order_domain_unverified", "native_order_policy_pair_unverified",
  "native_order_admission_unverified", "native_order_guard_unverified", "native_order_claim_guard_unverified",
] as const;

/** Preserve refusal precedence, including hard evidence failures before/after writes.
 * @experimental
 */
export function catalogPriceSetupRefusal(error: unknown): CatalogPriceSetupRefusal {
  const field = (key: string): unknown => error !== null && typeof error === "object" && key in error
    ? (error as Record<string, unknown>)[key] : undefined;
  const code = field("code"), message = field("message");
  if (code === "42501") return { outcome: "unauthorized", reason: "operator_required" };
  if (code === "40001") return { outcome: "conflict", reason: "expected_state_mismatch" };
  if (code === "55000" && message === "catalog_price_setup_readiness_would_fail") {
    let reasons: string[] | undefined;
    try {
      const parsed = catalogPriceSetupReasonsSchema.safeParse(JSON.parse(String(field("detail") ?? field("details"))));
      if (parsed.success) reasons = parsed.data;
    } catch { /* Only a valid bounded reason list is public. */ }
    return { outcome: "validation_issue", reason: "readiness_would_fail", ...(reasons ? { reasons } : {}) };
  }
  if (code === "55000") for (const reason of CATALOG_PRICE_SETUP_HARD_REFUSALS) {
    if (message === `catalog_price_setup_${reason}`) return { outcome: "dependency_unavailable", reason };
  }
  if (code === "22023") return { outcome: "validation_issue", reason: "invalid_store_request" };
  return { outcome: "dependency_unavailable", reason: "store_unavailable" };
}

/** A refusal aborts the caller-owned publication transaction, including prior child effects.
 * @experimental
 */
export class CatalogPriceSetupTransactionError extends Error {
  constructor(readonly refusal: CatalogPriceSetupRefusal) { super(refusal.reason); }
}
/** The price owner keeps receipt/context ordering and binds opaque batches to this executor and actor.
 * @experimental
 */
export function createCatalogPriceSetupTransactionWriter<Actor extends object>(resolveActor: (actor: Actor) => string) {
  const batches = new WeakMap<object, { db: CatalogPriceSetupQueryExecutor; actor: string; parent: string; value: unknown; commands: readonly CatalogPriceSetupCommand[] }>();
  const refuse = (reason: string): never => { throw new CatalogPriceSetupTransactionError({ outcome: "dependency_unavailable", reason }); };
  async function query(db: CatalogPriceSetupQueryExecutor, sql: string, values: unknown[]) {
    try {
      const result = await db.query(sql, values);
      if (result.rows.length !== 1 || result.rows[0]?.result === null || typeof result.rows[0]?.result !== "object") return refuse("invalid_store_response");
      const value = result.rows[0].result as Record<string, unknown>;
      if (value.outcome !== undefined && value.outcome !== "applied") {
        const parsed = catalogPriceSetupApplyResultSchema.safeParse(value);
        if (!parsed.success || !("reason" in parsed.data)) return refuse("invalid_store_response");
        throw new CatalogPriceSetupTransactionError(parsed.data);
      }
      return value;
    } catch (error) {
      if (error instanceof CatalogPriceSetupTransactionError) throw error;
      throw new CatalogPriceSetupTransactionError(catalogPriceSetupRefusal(error));
    }
  }
  return {
    async prelock(db: CatalogPriceSetupQueryExecutor, verifiedActor: Actor, parentProductId: string, commands: readonly CatalogPriceSetupCommand[]) {
      const actorId = resolveActor(verifiedActor);
      const batch = commands.map(command => {
        const canonicalCommand = canonicalCatalogPriceSetupCommand(command);
        return { canonicalCommand, fingerprint: createHash("sha256").update(canonicalCommand).digest("hex") };
      });
      const value = await query(db, "SELECT public.catalog_price_setup_prelock($1::uuid,$2::uuid,$3::jsonb) AS result", [actorId,parentProductId,JSON.stringify(batch)]);
      if (value.actorId !== actorId || value.parentProductId !== parentProductId || typeof value.transactionId !== "string"
        || !Array.isArray(value.batch) || value.batch.length !== batch.length
        || value.batch.some((entry, index) => entry?.canonicalCommand !== batch[index]!.canonicalCommand || entry?.fingerprint !== batch[index]!.fingerprint)) return refuse("invalid_store_response");
      const handle = Object.freeze({}); batches.set(handle, { db, actor: actorId, parent: parentProductId, value, commands }); return handle;
    },
    async applyInTransaction(db: CatalogPriceSetupQueryExecutor, verifiedActor: Actor, parentProductId: string, prelockedBatch: unknown) {
      const handle = prelockedBatch !== null && typeof prelockedBatch === "object" ? batches.get(prelockedBatch) : undefined;
      if (!handle || handle.db !== db || handle.actor !== resolveActor(verifiedActor) || handle.parent !== parentProductId) return refuse("price_prelock_invalid");
      batches.delete(prelockedBatch as object);
      const value = await query(db, "SELECT public.catalog_price_setup_apply_in_transaction($1::uuid,$2::uuid,$3::jsonb) AS result", [handle.actor,parentProductId,JSON.stringify(handle.value)]);
      if (value.outcome !== "applied" || !Array.isArray(value.results) || value.results.length !== handle.commands.length) return refuse("invalid_store_response");
      for (const [index, result] of value.results.entries()) {
        const parsed = catalogPriceSetupApplyResultSchema.safeParse(result), command = handle.commands[index]!;
        if (!parsed.success || (parsed.data.outcome !== "committed" && parsed.data.outcome !== "replayed")) return refuse("invalid_store_response");
        const receipt = parsed.data.receipt;
        if (receipt.actorId !== handle.actor || receipt.commandKey !== command.commandKey || receipt.variantId !== command.variantId
          || receipt.priceListId !== command.priceListId || receipt.current.unitPriceMinor !== command.unitPriceMinor) return refuse("invalid_store_response");
      }
    },
  };
}
