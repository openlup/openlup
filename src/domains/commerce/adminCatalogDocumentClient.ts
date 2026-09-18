import { requestBff, type BffRequestOptions } from "@/lib/bff/client";

import {
  CATALOG_DOCUMENT_REFUSALS,
  CatalogDocumentAuthorityError,
  getCatalogDocumentAuthorityResponseSchema,
  submitCatalogDocumentProposalResponseSchema,
  type CatalogDocumentRefusal,
  type SubmitCatalogDocumentProposalRequest,
} from "./adminCatalogDocumentContracts";

/**
 * Browser client for the catalog DOCUMENT authority seam, and for the one act
 * that seam deliberately does not carry.
 *
 * TWO TRANSPORTS, ON PURPOSE.
 *
 * Reading the current authority and proposing a candidate go over the admin BFF,
 * exactly like every other call in `adminCatalogClient.ts`: bearer token on the
 * request, response parsed against the shared contract schema.
 *
 * PUBLICATION DOES NOT. `catalog_record_publication_decision` and
 * `catalog_publish_candidate` are `GRANT ... authenticated` and defended by
 * `catalog_publication_require_human_admin()`, which reads `auth.uid()`. A BFF
 * route reaching them arrives as the service role with `auth.uid() = NULL`, so a
 * route made to work against that gate would launder a machine actor through a
 * human-only control. They are therefore called on the OPERATOR'S OWN session,
 * through an injected RPC port. This module names no client implementation: the
 * concrete session client is passed in by the panel, which keeps this file free
 * of a persistence import that `src/domains/commerce` may not carry.
 *
 * REFUSALS SURVIVE AS THEMSELVES. The seam answers a named refusal in
 * `details.reason` rather than as a generic failure. A client that collapsed
 * those into one message would leave the operator with "something went wrong"
 * where the seam said "your base revision is stale" - which is the whole reason
 * the named vocabulary exists. Every name in `CATALOG_DOCUMENT_REFUSALS` is
 * re-raised here as `CatalogDocumentAuthorityError`, carrying that exact code.
 */

const DOCUMENT_ROUTE = "/api/bff/admin/commerce/catalog/document";
const PROPOSAL_ROUTE = "/api/bff/admin/commerce/catalog/document-proposal";

const NAMED_REFUSALS: ReadonlySet<string> = new Set(CATALOG_DOCUMENT_REFUSALS);

function authHeaders(accessToken: string, options: BffRequestOptions): Headers {
  const headers = new Headers(options.headers);
  headers.set("Authorization", `Bearer ${accessToken}`);
  return headers;
}

/** The `details.reason` an error carries, whatever its transport, or null. */
function reasonOf(error: unknown): string | null {
  const details = error && typeof error === "object" && "details" in error
    ? (error as { details?: unknown }).details
    : null;
  const reason = details && typeof details === "object" && "reason" in details
    ? (details as { reason?: unknown }).reason
    : null;
  return typeof reason === "string" && reason ? reason : null;
}

/**
 * The named refusal an error carries, or null when it is not one. Exported so a
 * head can key its own copy off the name instead of re-deriving it from a
 * message string.
 */
export function catalogDocumentRefusalOf(error: unknown): CatalogDocumentRefusal | null {
  if (error instanceof CatalogDocumentAuthorityError) return error.code;
  const reason = reasonOf(error);
  return reason !== null && NAMED_REFUSALS.has(reason) ? (reason as CatalogDocumentRefusal) : null;
}

/**
 * Re-raise a named refusal as itself. Anything else is rethrown untouched - an
 * RPC token the seam passed through keeps its own `details.reason`, and a
 * transport failure stays a transport failure rather than being dressed up as a
 * refusal the seam never made.
 */
async function preservingRefusals<T>(work: Promise<T>): Promise<T> {
  try {
    return await work;
  } catch (error) {
    const refusal = catalogDocumentRefusalOf(error);
    if (refusal !== null) throw new CatalogDocumentAuthorityError(refusal);
    throw error;
  }
}

/**
 * The current document authority. Backed by the same current-document port the
 * public storefront read uses, so this answer and the shop's cannot diverge.
 */
export function readCatalogDocumentAuthority(
  accessToken: string,
  slug?: string,
  options: BffRequestOptions = {},
) {
  const query = slug ? `?slug=${encodeURIComponent(slug)}` : "";
  return preservingRefusals(
    requestBff(`${DOCUMENT_ROUTE}${query}`, getCatalogDocumentAuthorityResponseSchema, {
      ...options,
      method: "GET",
      headers: authHeaders(accessToken, options),
    }),
  );
}

/**
 * One operation, two modes. `dry_run` re-digests the candidate, checks the
 * declared base revisions and returns the semantic diff WITHOUT writing;
 * `commit` additionally submits the candidate to the change-proposal inbox.
 * Neither mode publishes anything.
 */
export function submitCatalogDocumentProposal(
  accessToken: string,
  request: SubmitCatalogDocumentProposalRequest,
  options: BffRequestOptions = {},
) {
  return preservingRefusals(
    requestBff(PROPOSAL_ROUTE, submitCatalogDocumentProposalResponseSchema, {
      ...options,
      method: "POST",
      headers: authHeaders(accessToken, options),
      body: request,
    }),
  );
}

export type CatalogDocumentAuthorityResponse =
  Awaited<ReturnType<typeof readCatalogDocumentAuthority>>;
export type CatalogDocumentProposalResponse =
  Awaited<ReturnType<typeof submitCatalogDocumentProposal>>;

// -- publication: the operator's own session ---------------------------------

/**
 * The minimum an authenticated session client has to offer. Deliberately
 * structural: this module must not import a persistence client, and the panel
 * passes the app's own browser session client in.
 */
export interface CatalogPublicationRpcClient {
  rpc(
    name: string,
    args: Record<string, unknown>,
  ): PromiseLike<{ data: unknown; error: { code?: string; message?: string } | null }>;
}

/** A publication RPC refusal, carrying the token the function raised. */
export class CatalogPublicationRpcError extends Error {
  constructor(readonly reason: string, readonly sqlstate?: string) {
    super(reason);
    this.name = "CatalogPublicationRpcError";
  }
}

export interface PublishCatalogDocumentCandidateInput {
  candidateId: string;
  candidateDigest: string;
  expectedCurrentDigest: string;
}

export interface CatalogDocumentPublicationResult {
  decisionId: string;
  decisionReplayed: boolean;
  eventId: string;
  postDigest: string;
  publicationReplayed: boolean;
}

function record(data: unknown): Record<string, unknown> {
  const row = Array.isArray(data) ? data[0] : data;
  return row && typeof row === "object" ? (row as Record<string, unknown>) : {};
}

async function callPublicationRpc(
  client: CatalogPublicationRpcClient,
  name: string,
  args: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const { data, error } = await client.rpc(name, args);
  if (error) {
    throw new CatalogPublicationRpcError(error.message ?? name, error.code);
  }
  return record(data);
}

/**
 * Approve, then publish, on the caller's own session.
 *
 * The two command keys are DERIVED from the candidate rather than typed by the
 * operator, because both functions treat `p_command_key` as their idempotency
 * key: a repeat of the same candidate replays the first decision and the first
 * publication instead of raising a conflict, and an operator cannot mistype a
 * key into a second live publication.
 */
export async function publishCatalogDocumentCandidate(
  client: CatalogPublicationRpcClient,
  input: PublishCatalogDocumentCandidateInput,
): Promise<CatalogDocumentPublicationResult> {
  const commandBase = `catalog-document-panel:${input.candidateId}:${input.candidateDigest}`;
  const decision = await callPublicationRpc(client, "catalog_record_publication_decision", {
    p_candidate_id: input.candidateId,
    p_candidate_digest: input.candidateDigest,
    p_decision: "approve",
    p_command_key: `${commandBase}:approve`,
  });
  const publication = await callPublicationRpc(client, "catalog_publish_candidate", {
    p_candidate_id: input.candidateId,
    p_expected_current_digest: input.expectedCurrentDigest,
    p_command_key: `${commandBase}:publish`,
  });
  return {
    decisionId: String(decision.decisionId ?? ""),
    decisionReplayed: decision.replayed === true,
    eventId: String(publication.eventId ?? ""),
    postDigest: String(publication.postDigest ?? ""),
    publicationReplayed: publication.replayed === true,
  };
}

/** Re-exported so a head reads one vocabulary without a second import path. */
export { CatalogDocumentAuthorityError };
