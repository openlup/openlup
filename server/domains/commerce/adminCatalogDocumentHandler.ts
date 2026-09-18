import { COMMERCE_CONTRACT_VERSION } from "../../../src/domains/commerce/types.js";
import {
  CatalogDocumentAuthorityError,
  createCatalogDocumentDiff,
  type CatalogDocumentRefusal,
  digestUtf8,
  getCatalogDocumentAuthorityResponseSchema,
  submitCatalogDocumentProposalResponseSchema,
  type AdminCatalogDocumentDataPort,
  type CatalogDocumentAuthorityRead,
  type CatalogDocumentJsonValue,
  type CatalogDocumentSemanticDelta,
  type CatalogDocumentValidator,
  type GetCatalogDocumentAuthorityRequest,
  type SubmitCatalogDocumentProposalRequest,
  type SubmitCatalogDocumentProposalResult,
} from "../../../src/domains/commerce/adminCatalogDocumentContracts.js";
import {
  catalogSpec,
  type CatalogMutationKey,
  type CatalogQueryKey,
} from "../../../src/domains/commerce/catalogSpec.js";
import type {
  AgentDomainMutationSpec,
  AgentDomainQuerySpec,
} from "../../../src/lib/agent-domain/domainSpec.js";
import {
  createAdminMutationHandler,
  createAdminParameterizedReadHandler,
} from "../../_lib/admin-domain/handlers.js";
import type { AuthorizeAdmin } from "../../_lib/admin-domain/auth.js";
import { DomainRpcError, mapRpcError } from "../../_lib/admin-domain/rpcErrors.js";
import { sendBffError } from "../../_lib/bff/response.js";
import type { VercelResponse } from "../../_lib/types/vercel.js";

/**
 * The HTTP seam over the existing catalog document authority. Two operations
 * driven by `catalogSpec`, on the same kit spine every other agent-operable
 * admin domain uses (`adminCatalogReadHandler.ts` is the banner reference).
 *
 * BOUNDARY - do not extend this module with a publish, decision or rollback
 * operation, in any mode. Those three RPCs are `GRANT ... authenticated` and
 * defended by a human-admin gate that reads `auth.uid()`; a service-role BFF
 * route reaching them has `auth.uid() = NULL`, and a route made to "work"
 * against that gate would launder a machine actor through a human-only control.
 * The operator's browser calls them on its own session instead.
 *
 * NEUTRALITY - this module and its contracts are counted, zero-slack publishable
 * surfaces. A candidate document is therefore OPAQUE here: its schema, its field
 * vocabulary and its array identity are deployment knowledge, injected through
 * {@link AdminCatalogDocumentHandlerDeps.validateDocument} and
 * {@link AdminCatalogDocumentHandlerDeps.diffDocumentValues}. Never import a
 * document schema, a product name or a deployment module into this file.
 */

const DOCUMENT_READ_INVALID = "Invalid catalog document request";
const DOCUMENT_READ_FAILURE = "Catalog document read failed";
const PROPOSAL_INVALID = "Invalid catalog document proposal request";
const PROPOSAL_FAILURE = "Catalog document proposal failed";

export interface AdminCatalogDocumentHandlerDeps {
  dataPort: AdminCatalogDocumentDataPort;
  authorizeAdmin: AuthorizeAdmin;
  /** Deployment document validation; absent means the submission RPC is the sole authority. */
  validateDocument?: CatalogDocumentValidator;
  /** Deployment-bound semantic differ; absent means the neutral default engine. */
  diffDocumentValues?: ReturnType<typeof createCatalogDocumentDiff>;
}

function query<TReq>(key: CatalogQueryKey): AgentDomainQuerySpec<TReq> {
  const spec = catalogSpec.queries?.[key];
  if (!spec) throw new Error(`catalogSpec.queries.${key} is not defined`);
  return spec as AgentDomainQuerySpec<TReq>;
}

function mutation<TReq>(key: CatalogMutationKey): AgentDomainMutationSpec<TReq> {
  const spec = catalogSpec.mutations[key];
  if (!spec) throw new Error(`catalogSpec.mutations.${key} is not defined`);
  return spec as AgentDomainMutationSpec<TReq>;
}

export function createAdminCatalogDocumentAuthorityHandler(deps: AdminCatalogDocumentHandlerDeps) {
  return createAdminParameterizedReadHandler<GetCatalogDocumentAuthorityRequest, CatalogDocumentAuthorityRead>({
    query: query<GetCatalogDocumentAuthorityRequest>("document"),
    authorizeAdmin: deps.authorizeAdmin,
    load: (_actorId, input) => deps.dataPort.readAuthority(input.slug),
    toResponse: (data) => ({
      contractVersion: COMMERCE_CONTRACT_VERSION,
      scopeSlugs: data.scopeSlugs,
      products: data.products,
    }),
    responseSchema: getCatalogDocumentAuthorityResponseSchema,
    invalidRequestMessage: DOCUMENT_READ_INVALID,
    invalidResponseMessage: "Invalid catalog document response",
    failureMessage: DOCUMENT_READ_FAILURE,
    mapError: mapCatalogDocumentError,
  });
}

export function createAdminCatalogDocumentProposalHandler(deps: AdminCatalogDocumentHandlerDeps) {
  return createAdminMutationHandler<SubmitCatalogDocumentProposalRequest, SubmitCatalogDocumentProposalResult>({
    mutation: mutation<SubmitCatalogDocumentProposalRequest>("proposeDocument"),
    authorizeAdmin: deps.authorizeAdmin,
    invoke: (_actorId, input) => resolveProposal(deps, input),
    toResponse: (result) => ({ contractVersion: COMMERCE_CONTRACT_VERSION, ...result }),
    responseSchema: submitCatalogDocumentProposalResponseSchema,
    invalidRequestMessage: PROPOSAL_INVALID,
    invalidResponseMessage: "Invalid catalog document proposal response",
    failureMessage: PROPOSAL_FAILURE,
    mapError: mapCatalogDocumentError,
  });
}

/**
 * One operation in two modes. `dry_run` stops before the submission RPC, so a
 * caller can re-digest, freshness-check and diff a candidate without writing
 * anything. A candidate declaring a base digest that is not the product's
 * current one is refused by name - never rebased onto the newer revision.
 *
 * FAIL CLOSED: `dry_run` exists to validate, so it refuses outright when no
 * deployment validator is bound. A mode that advertises validation and silently
 * performs none is worse than one that refuses. `commit` may proceed without a
 * bound validator only because the submission RPC is itself a real authority.
 */
async function resolveProposal(
  deps: AdminCatalogDocumentHandlerDeps,
  input: SubmitCatalogDocumentProposalRequest,
): Promise<SubmitCatalogDocumentProposalResult> {
  const candidateDigest = await digestUtf8(input.candidate.canonicalText);
  if (candidateDigest !== input.candidate.envelopeSha256) {
    throw new CatalogDocumentAuthorityError("catalog_document_candidate_digest_mismatch");
  }
  if (input.mode === "dry_run" && !deps.validateDocument) {
    throw new CatalogDocumentAuthorityError("catalog_document_validation_unavailable");
  }

  const authority = await deps.dataPort.readAuthority();
  const currentDigestBySlug = new Map(authority.products.map((product) => [product.slug, product.documentDigest]));
  for (const base of input.baseDocumentDigests) {
    if (!authority.scopeSlugs.includes(base.productSlug)) {
      throw new CatalogDocumentAuthorityError("catalog_document_scope_unknown");
    }
    if (currentDigestBySlug.get(base.productSlug) !== base.documentDigest) {
      throw new CatalogDocumentAuthorityError("catalog_document_stale_base_digest");
    }
  }

  const diff = deps.diffDocumentValues ?? createCatalogDocumentDiff();
  const declaredBase = new Set(input.baseDocumentDigests.map((base) => base.productSlug));
  const deltas: CatalogDocumentSemanticDelta[] = [];
  for (const candidate of input.candidate.documents) {
    if (!authority.scopeSlugs.includes(candidate.productSlug)) {
      throw new CatalogDocumentAuthorityError("catalog_document_scope_unknown");
    }
    // Freshness must COVER the rewrite. Without this, a caller could declare
    // one product's current digest while the candidate rewrites a different
    // product, and pass the freshness check vacuously.
    if (!declaredBase.has(candidate.productSlug)) {
      throw new CatalogDocumentAuthorityError("catalog_document_stale_base_digest");
    }
    await validateCandidateDocument(deps, candidate.productSlug, candidate.document);
    deltas.push(...diff(candidate.productSlug, "", authority.documents.get(candidate.productSlug), candidate.document));
  }

  if (input.mode === "dry_run") return { mode: "dry_run", candidateDigest, deltas, submitted: null };
  const submitted = await deps.dataPort.submitChangeProposal(
    input.candidate.canonicalText,
    input.candidate.envelopeSha256,
  );
  return { mode: "commit", candidateDigest, deltas, submitted };
}

async function validateCandidateDocument(
  deps: AdminCatalogDocumentHandlerDeps,
  productSlug: string,
  document: CatalogDocumentJsonValue,
): Promise<void> {
  if (!deps.validateDocument) return;
  try {
    await deps.validateDocument(productSlug, document);
  } catch (error) {
    if (error instanceof CatalogDocumentAuthorityError) throw error;
    throw new CatalogDocumentAuthorityError("catalog_document_candidate_invalid");
  }
}

/**
 * Named refusals, never a generic failure. The seam's own refusals map to a
 * stable code carrying `details.reason`; the submission RPC's `22023`/`55000`
 * RAISEs carry their own token through unchanged, so an operator head and an
 * agent head read one vocabulary. Everything else falls back to the shared kit
 * map.
 */
const CALLER_REFUSALS = new Set<CatalogDocumentRefusal>([
  "catalog_document_candidate_digest_mismatch",
  "catalog_document_candidate_invalid",
  "catalog_document_scope_unknown",
]);

/** SQLSTATEs the submission RPC RAISEs with a named token worth preserving. */
const RPC_NAMED_SQLSTATES = new Set(["22023", "23505", "55000"]);

export function mapCatalogDocumentError(
  res: VercelResponse,
  error: unknown,
  failureMessage: string,
): void {
  if (error instanceof CatalogDocumentAuthorityError) {
    // Three kinds, three codes. A malformed or unknown-scope request is the
    // CALLER's mistake (400). A missing capability - the deployment validator
    // this mode requires, or the document authority itself - is 503, never a
    // silent success. Only a genuine race with the live revision is 409.
    const code = CALLER_REFUSALS.has(error.code) ? "BAD_REQUEST"
      : error.code.endsWith("_unavailable") ? "UPSTREAM_UNAVAILABLE"
        : "CONFLICT";
    sendBffError(res, code, error.code, { details: { reason: error.code } });
    return;
  }
  // The submission RPC RAISEs a named token for every refusal, including
  // `catalog_proposal_conflict` on 23505. The shared kit map flattens 23505 to
  // "already_exists", so these three carry their own name through instead.
  if (error instanceof DomainRpcError && RPC_NAMED_SQLSTATES.has(error.sqlstate ?? "")) {
    sendBffError(res, "CONFLICT", error.pgMessage, { details: { reason: error.pgMessage } });
    return;
  }
  mapRpcError(res, error, failureMessage);
}
