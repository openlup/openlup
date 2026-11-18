import type { PgQueryExecutor } from "../data/index.js";
import type { CatalogPublicationDependencies } from "./publicationPortsV2.js";
import type { CatalogPublicationFailure } from "./contracts/publication.js";
import { z } from "./validation.js";

const id = z.guid().refine(value => value === value.toLowerCase());
const digest = z.string().regex(/^[a-f0-9]{64}$/u);
const key = z.string().min(1).max(240).refine(value => value.trim() === value);
const documentText = z.string().min(2).max(2_097_152).optional();
const preflightInput = z.object({ productId: id, documentText }).strict();
const command = preflightInput.extend({ sourceDigest: digest, commandKey: key }).strict();
const scope = z.object({ productId: id, commandKey: key }).strict();
const preflightSchema = z.object({ schemaVersion: z.literal(1), productId: id, actorId: id, sourceDigest: digest,
  evidence: z.object({ product: z.record(z.string(), z.json()), definitionDigest: digest, document: z.record(z.string(), z.json()),
    skus: z.array(z.record(z.string(), z.json())).min(1).max(10_000), prices: z.array(z.json()), obligations: z.array(z.json()) }).strict(),
}).strict();
const receiptSchema = z.object({ schemaVersion: z.literal(1), kind: z.literal("adoption"), sourceKind: z.literal("adopted_existing"),
  productId: id, commandKey: key, actorId: id, fingerprint: digest, sourceDigest: digest, publicationDigest: digest,
  previousHead: z.null(), head: z.object({ publicationId: id, revision: z.literal(1), documentDigest: digest }).strict(),
  committedAt: z.string().regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/u),
  skuCount: z.number().int().min(1).max(10_000), legacyBindingCount: z.number().int().nonnegative(),
}).strict();

/** Observation to review before approving its digest. Contains restricted operator evidence. @experimental */
export type CatalogAdoptionPreflight = z.infer<typeof preflightSchema>;
/** Immutable receipt for a first publication from an existing installation. @experimental */
export type CatalogAdoptionReceipt = z.infer<typeof receiptSchema>;

const unavailable: CatalogPublicationFailure = { outcome: "dependency_unavailable", reason: "catalog_adoption_unavailable" };
const denied: CatalogPublicationFailure = { outcome: "unauthorized", reason: "publisher_not_authorized" };
const invalid: CatalogPublicationFailure = { outcome: "validation_issue", reason: "catalog_adoption_command_invalid" };
const known: Readonly<Record<string, CatalogPublicationFailure["outcome"]>> = {
  catalog_adoption_scope_absent: "validation_issue",
  catalog_adoption_type_unavailable: "validation_issue",
  catalog_adoption_document_unavailable: "validation_issue",
  catalog_adoption_document_digest_mismatch: "validation_issue",
  catalog_adoption_document_shape_invalid: "validation_issue",
  catalog_adoption_identifier_unavailable: "validation_issue",
  catalog_adoption_facts_invalid: "validation_issue",
  catalog_adoption_unbound_obligation: "validation_issue",
  catalog_adoption_price_overlap: "validation_issue",
  catalog_adoption_command_invalid: "validation_issue",
  catalog_adoption_already_published: "conflict",
  catalog_adoption_lineage_invalid: "dependency_unavailable",
  catalog_adoption_identity_conflict: "conflict",
  catalog_adoption_source_changed: "conflict",
  catalog_adoption_busy: "conflict",
  catalog_adoption_operator_mismatch: "unauthorized",
  catalog_adoption_command_key_reused: "conflict",
  catalog_adoption_receipt_invalid: "dependency_unavailable",
};
function failure(error: unknown): CatalogPublicationFailure {
  if (!(error instanceof Error)) return unavailable;
  const outcome = Object.hasOwn(known, error.message) ? known[error.message] : undefined;
  if (outcome) return { outcome, reason: error.message };
  return "code" in error && error.code === "42501" ? denied : unavailable;
}

/**
 * Explicit operator binding. The transaction must use a restricted session
 * derived from the same verified human context on one connection.
 * @experimental
 */
export function createPostgresCatalogAdoption<Context>(deps: {
  authorizeHuman: CatalogPublicationDependencies<Context>["authorizeHuman"];
  transaction<T>(context: Context, work: (db: PgQueryExecutor) => Promise<T>): Promise<T>;
}) {
  async function run<T>(context: Context, work: (db: PgQueryExecutor, actorId: string) => Promise<T>): Promise<T | CatalogPublicationFailure> {
    try {
      const auth = await deps.authorizeHuman(context);
      if (!auth.ok || auth.role !== "admin" || auth.isMachineActor !== false || !id.safeParse(auth.userId).success) return denied;
      return await deps.transaction(context, db => work(db, auth.userId));
    } catch (error) { return failure(error); }
  }
  function verifyReceipt(value: unknown, actorId: string, input: z.infer<typeof scope>): CatalogAdoptionReceipt {
    const receipt = receiptSchema.parse(value);
    if (receipt.actorId !== actorId || receipt.productId !== input.productId || receipt.commandKey !== input.commandKey) {
      throw new Error("catalog_adoption_receipt_invalid");
    }
    return receipt;
  }
  return {
    async preflight(input: z.input<typeof preflightInput>, context: Context) {
      const parsed = preflightInput.safeParse(input);
      if (!parsed.success) return invalid;
      return run(context, async (db, actorId) => {
        const { rows } = await db.query("SELECT public.catalog_adoption_preflight($1::uuid,$2::text) AS value",
          [parsed.data.productId, parsed.data.documentText ?? null]);
        const result = preflightSchema.parse(rows.length === 1 ? rows[0]?.value : null);
        if (result.actorId !== actorId || result.productId !== parsed.data.productId) throw new Error("catalog_adoption_operator_mismatch");
        return { outcome: "verified" as const, preflight: result };
      });
    },
    async adopt(input: z.input<typeof command>, context: Context) {
      const parsed = command.safeParse(input);
      if (!parsed.success) return invalid;
      return run(context, async (db, actorId) => {
        const { productId, sourceDigest, commandKey, documentText } = parsed.data;
        const { rows } = await db.query("SELECT public.catalog_adopt_existing($1::uuid,$2::text,$3::text,$4::text) AS value",
          [productId, sourceDigest, commandKey, documentText ?? null]);
        const result = z.object({ outcome: z.enum(["committed", "replayed"]), receipt: z.unknown() }).strict()
          .parse(rows.length === 1 ? rows[0]?.value : null);
        const receipt = verifyReceipt(result.receipt, actorId, parsed.data);
        if (receipt.sourceDigest !== sourceDigest) throw new Error("catalog_adoption_receipt_invalid");
        return { outcome: result.outcome, receipt };
      });
    },
    async receipt(input: z.input<typeof scope>, context: Context) {
      const parsed = scope.safeParse(input);
      if (!parsed.success) return invalid;
      return run(context, async (db, actorId) => {
        const { rows } = await db.query("SELECT public.catalog_adoption_receipt($1::uuid,$2::text) AS value",
          [parsed.data.productId, parsed.data.commandKey]);
        if (rows.length !== 1) throw new Error("catalog_adoption_receipt_invalid");
        const value = rows[0]?.value;
        return value === null ? { outcome: "absent" as const } : { outcome: "found" as const, receipt: verifyReceipt(value, actorId, parsed.data) };
      });
    },
  };
}

/**
 * Read the immutable first revision from a restricted read executor. The host
 * authorizes retained SKU access before choosing a scope.
 * @experimental
 */
export function createPostgresCatalogAdoptionReader(executor: PgQueryExecutor) {
  const initialSchema = z.object({ schemaVersion: z.literal(1), kind: z.literal("adopted_existing"), productId: id,
    head: receiptSchema.shape.head, sourceDigest: digest, publicationDigest: digest, current: z.boolean(),
    canonicalState: z.string().min(2).max(16_777_216), skuFacts: z.string().min(2).max(2_097_152).nullable(),
    skuReference: z.object({ skuId: id, revisionId: id, revision: z.literal(1), digest }).strict().nullable(),
  }).strict();
  return async (input: { productId: string; skuId?: string }) => {
    const parsed = z.object({ productId: id, skuId: id.optional() }).strict().safeParse(input);
    if (!parsed.success) return invalid;
    try {
      const { productId, skuId } = parsed.data;
      const { rows } = await executor.query("SELECT public.catalog_adoption_read($1::uuid,$2::uuid) AS value",
        [productId, skuId ?? null]);
      if (rows.length !== 1) return unavailable;
      if (rows[0]?.value === null) return { outcome: "absent" as const };
      const readback = initialSchema.parse(rows[0]?.value);
      if (readback.productId !== productId || (readback.skuReference?.skuId ?? undefined) !== skuId ||
          (readback.skuFacts === null) !== (readback.skuReference === null)) return unavailable;
      return { outcome: "found" as const, readback };
    } catch (error) { return failure(error); }
  };
}
