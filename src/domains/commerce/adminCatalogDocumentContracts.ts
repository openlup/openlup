import { z } from "../../lib/validation/zod.js";

import { adminModeFields } from "../../lib/agent-domain/ruleResult.js";
import { catalogProductSlugSchema } from "../catalog/contracts.js";
import { COMMERCE_CONTRACT_VERSION } from "./types.js";

/**
 * Admin/agent CATALOG DOCUMENT contracts — the deployment-neutral half of the
 * document-authority seam.
 *
 * BOUNDARY (load-bearing, see `docs/plan/catalog-wave3f-a-document-backend.md`
 * section 1): the concrete product document is a DEPLOYMENT concern. Its schema,
 * its field vocabulary and the exact scope a proposal may carry all live in the
 * deployment overlay. This module therefore describes a candidate as OPAQUE
 * canonical JSON: the exact bytes the submission RPC will receive, the caller's
 * declared digest over them, and plain JSON values for the semantic diff. It
 * names no document field, product or deployment, so `src/domains` stays inside
 * its zero-token neutrality budget. Deep, schema-aware candidate validation is
 * an INJECTED port ({@link CatalogDocumentValidator}); the submission RPC stays
 * the authority whether or not a deployment supplies one.
 */

/** Plain JSON, the only shape this seam knows about a document. */
export type CatalogDocumentJsonValue =
  null | boolean | number | string | CatalogDocumentJsonValue[] | { [key: string]: CatalogDocumentJsonValue };

const sha256Schema = z.string().regex(/^[a-f0-9]{64}$/u);

const jsonValueSchema: z.ZodType<CatalogDocumentJsonValue> = z.lazy(() => z.union([
  z.null(), z.boolean(), z.number(), z.string(),
  z.array(jsonValueSchema), z.record(z.string(), jsonValueSchema),
]));

const responseVersionField = { contractVersion: z.literal(COMMERCE_CONTRACT_VERSION) } as const;

/**
 * Named refusals this seam raises before (or instead of) the submission RPC,
 * returned as `details.reason` rather than as a generic failure so an operator
 * head and an agent head read one vocabulary.
 */
export const CATALOG_DOCUMENT_REFUSALS = [
  "catalog_document_authority_unavailable",
  "catalog_document_candidate_digest_mismatch",
  "catalog_document_candidate_invalid",
  "catalog_document_scope_unknown",
  "catalog_document_stale_base_digest",
  "catalog_document_validation_unavailable",
] as const;
export type CatalogDocumentRefusal = (typeof CATALOG_DOCUMENT_REFUSALS)[number];

/** A refusal carrying one of the names above; never rebased, never generic. */
export class CatalogDocumentAuthorityError extends Error {
  constructor(readonly code: CatalogDocumentRefusal) {
    super(code);
    this.name = "CatalogDocumentAuthorityError";
  }
}

// ── read: the current document authority ─────────────────────────────────────

export const getCatalogDocumentAuthorityRequestSchema = z
  .object({ slug: catalogProductSlugSchema.optional() })
  .strict();

export const catalogDocumentAuthorityProductSchema = z.object({
  slug: z.string(),
  productId: z.string(),
  productStatus: z.string(),
  primarySkuId: z.string().nullable(),
  skuCode: z.string().nullable(),
  skuStatus: z.string().nullable(),
  netContentGrams: z.number().int().nullable(),
  sellableStandalone: z.boolean().nullable(),
  sellableInSubscription: z.boolean().nullable(),
  primaryTradeItemRef: z.string().nullable(),
  documentRevisionId: z.string().nullable(),
  revisionNo: z.number().int().positive().nullable(),
  documentSchemaId: z.string().nullable(),
  documentDigest: sha256Schema.nullable(),
});

export const getCatalogDocumentAuthorityResponseSchema = z.object({
  ...responseVersionField,
  /** Slugs of the products that currently carry a document pointer, slug-ordered. */
  scopeSlugs: z.array(z.string()),
  products: z.array(catalogDocumentAuthorityProductSchema),
});

export type GetCatalogDocumentAuthorityRequest =
  z.infer<typeof getCatalogDocumentAuthorityRequestSchema>;
export type CatalogDocumentAuthorityProduct =
  z.infer<typeof catalogDocumentAuthorityProductSchema>;

/** Everything the read route answers with, plus the payloads the diff needs. */
export interface CatalogDocumentAuthorityRead {
  scopeSlugs: string[];
  products: CatalogDocumentAuthorityProduct[];
  /** Current revision payload by slug, for every product in scope. */
  documents: Map<string, CatalogDocumentJsonValue>;
}

// ── write: one operation, two modes ──────────────────────────────────────────

export const catalogDocumentCandidateSchema = z
  .object({
    /** Exact UTF-8 bytes the submission RPC receives; opaque to this seam. */
    canonicalText: z.string().min(2).max(1_048_576),
    /** The caller's declared digest over those bytes. */
    envelopeSha256: sha256Schema,
    /** Per-product candidate payloads the semantic diff is computed against. */
    documents: z
      .array(z.object({ productSlug: z.string().trim().min(1).max(120), document: jsonValueSchema }).strict())
      .max(64)
      .default([]),
  })
  .strict();

export const catalogDocumentBaseDigestSchema = z
  .object({ productSlug: z.string().trim().min(1).max(120), documentDigest: sha256Schema })
  .strict();

export const submitCatalogDocumentProposalRequestSchema = z
  .object({
    // No `idempotencyKey`: the submission RPC has no such parameter, and the
    // envelope digest is already its natural key (a replay of identical bytes
    // returns `inserted: false`). Advertising a field nothing reads would be a
    // false promise of replay semantics this seam does not own.
    ...adminModeFields,
    /**
     * The current revision digest, per product, the candidate was authored
     * against. This is the same per-product digest the storefront reads, so the
     * panel and the storefront cannot disagree about what "current" means. A
     * declared digest that is not the current one is refused by name, never
     * rebased. There is deliberately no aggregate state digest here: the
     * publication candidate ledger is revoked from every runtime role.
     */
    baseDocumentDigests: z.array(catalogDocumentBaseDigestSchema).min(1).max(64),
    candidate: catalogDocumentCandidateSchema,
  })
  .strict();

export const catalogDocumentSemanticDeltaSchema = z.object({
  productSlug: z.string(),
  path: z.string(),
  currentValue: jsonValueSchema,
  targetValue: jsonValueSchema,
});

export const submitCatalogDocumentProposalResponseSchema = z.object({
  ...responseVersionField,
  mode: z.enum(["commit", "dry_run"]),
  /** Recomputed over the supplied bytes; equal to the caller's claim or refused. */
  candidateDigest: sha256Schema,
  deltas: z.array(catalogDocumentSemanticDeltaSchema),
  /** Null on `dry_run`: nothing was written. */
  submitted: z
    .object({
      proposalId: z.string(),
      proposalSha256: sha256Schema,
      envelopeSha256: sha256Schema,
      inserted: z.boolean(),
    })
    .nullable(),
});

export type SubmitCatalogDocumentProposalRequest =
  z.infer<typeof submitCatalogDocumentProposalRequestSchema>;
export type CatalogDocumentSemanticDelta = z.infer<typeof catalogDocumentSemanticDeltaSchema>;

export interface CatalogChangeProposalSubmission {
  proposalId: string;
  proposalSha256: string;
  envelopeSha256: string;
  inserted: boolean;
}

export interface SubmitCatalogDocumentProposalResult {
  mode: "commit" | "dry_run";
  candidateDigest: string;
  deltas: CatalogDocumentSemanticDelta[];
  submitted: CatalogChangeProposalSubmission | null;
}

/**
 * The deployment seam: a deployment that owns a document schema supplies this so
 * an invalid candidate is refused before the RPC. The core imports no schema.
 */
export type CatalogDocumentValidator = (
  productSlug: string,
  document: CatalogDocumentJsonValue,
) => Promise<void> | void;

/** Server-side data access; every method is a pure read except the submission. */
export interface AdminCatalogDocumentDataPort {
  readAuthority(slug?: string): Promise<CatalogDocumentAuthorityRead>;
  submitChangeProposal(
    canonicalText: string,
    envelopeSha256: string,
  ): Promise<CatalogChangeProposalSubmission>;
}

// ── the diff engine, one implementation ──────────────────────────────────────

/** SHA-256 over exact UTF-8 bytes — the same digest the submission RPC computes. */
export async function digestUtf8(text: string): Promise<string> {
  const crypto = globalThis.crypto;
  if (!crypto?.subtle) throw new Error("Web Crypto SHA-256 is unavailable");
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

/** Array member identity, so a reorder is not read as a rewrite; null falls back to position. */
export type CatalogDocumentArrayIdentity = (value: Record<string, CatalogDocumentJsonValue>) => string | null;

export interface CatalogDocumentDiffStrategy {
  /** Deterministic serialization used for node equality. */
  canonicalize: (value: CatalogDocumentJsonValue) => string;
  arrayIdentity: CatalogDocumentArrayIdentity;
}

/** Neutral fallback: order-independent only for `{id}`/`{key}` records. */
export const defaultCatalogDocumentDiffStrategy: CatalogDocumentDiffStrategy = {
  canonicalize: stableJsonText,
  arrayIdentity: (value) => (typeof value.id === "string" ? `id=${value.id}`
    : typeof value.key === "string" ? `key=${value.key}` : null),
};

/**
 * The single semantic-diff engine, lifted out of the build-time candidate
 * compiler (which imports three large JSON receipts and therefore cannot be
 * loaded by a serverless route). The traversal is deployment-neutral; the two
 * parts that are NOT (how a document array is identified, and which canonical
 * serialization its receipts were sealed with) arrive as an injected strategy.
 * The deployment overlay binds its own and re-exports the bound function, so
 * every existing caller and every committed receipt stays byte-identical.
 */
export function createCatalogDocumentDiff(
  strategy: Partial<CatalogDocumentDiffStrategy> = {},
) {
  const { canonicalize, arrayIdentity } = { ...defaultCatalogDocumentDiffStrategy, ...strategy };
  const absent = (): CatalogDocumentJsonValue => ({ $absent: true });

  const keyedArray = (values: CatalogDocumentJsonValue[]): Map<string, CatalogDocumentJsonValue> | null => {
    const pairs = values.map((value): [string, CatalogDocumentJsonValue] | null => {
      if (!recordValue(value)) return null;
      const key = arrayIdentity(value);
      return key ? [key, value] : null;
    });
    if (pairs.some((pair) => pair === null)) return null;
    const result = new Map(pairs as Array<[string, CatalogDocumentJsonValue]>);
    return result.size === values.length ? result : null;
  };

  return function diff(
    productSlug: string,
    path: string,
    current: CatalogDocumentJsonValue | undefined,
    target: CatalogDocumentJsonValue | undefined,
  ): CatalogDocumentSemanticDelta[] {
    if (
      canonicalize(current === undefined ? absent() : current)
      === canonicalize(target === undefined ? absent() : target)
    ) return [];
    if (Array.isArray(current) && Array.isArray(target)) {
      const keyedCurrent = keyedArray(current);
      const keyedTarget = keyedArray(target);
      if (keyedCurrent && keyedTarget) {
        return [...new Set([...keyedCurrent.keys(), ...keyedTarget.keys()])].sort().flatMap((key) =>
          diff(productSlug, `${path}[${key}]`, keyedCurrent.get(key), keyedTarget.get(key)));
      }
      return Array.from({ length: Math.max(current.length, target.length) }, (_, index) =>
        diff(productSlug, `${path}[${index}]`, current[index], target[index])).flat();
    }
    if (recordValue(current) && recordValue(target)) {
      return [...new Set([...Object.keys(current), ...Object.keys(target)])].sort().flatMap((key) =>
        diff(productSlug, path ? `${path}.${key}` : key, current[key], target[key]));
    }
    return [{
      productSlug,
      path,
      currentValue: current === undefined ? absent() : current,
      targetValue: target === undefined ? absent() : target,
    }];
  };
}

function recordValue(value: CatalogDocumentJsonValue | undefined): value is Record<string, CatalogDocumentJsonValue> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

/** Key-sorted JSON text; the neutral node-equality serialization. */
function stableJsonText(value: CatalogDocumentJsonValue): string {
  if (value === null || typeof value === "boolean" || typeof value === "string") return JSON.stringify(value);
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new TypeError("diff values must be finite JSON numbers");
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(stableJsonText).join(",")}]`;
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableJsonText(value[key]!)}`).join(",")}}`;
}
