import { describe, expect, it, vi } from "vitest";

import { BffClientError } from "@/lib/bff/client";

import {
  catalogDocumentRefusalOf,
  CatalogPublicationRpcError,
  publishCatalogDocumentCandidate,
  readCatalogDocumentAuthority,
  submitCatalogDocumentProposal,
  type CatalogPublicationRpcClient,
} from "./adminCatalogDocumentClient";
import {
  CATALOG_DOCUMENT_REFUSALS,
  CatalogDocumentAuthorityError,
  type SubmitCatalogDocumentProposalRequest,
} from "./adminCatalogDocumentContracts";

/**
 * The real `requestBff` runs here against a stub fetcher rather than a mocked
 * module: what is under test is whether a NAMED refusal survives the round trip
 * as itself, and a mocked transport would let the assertion pass over a client
 * that never looked at `details.reason` at all.
 */

const DIGEST_A = "a".repeat(64);
const DIGEST_B = "b".repeat(64);

function jsonResponse(body: unknown, status = 200): Response {
  return { status, json: () => Promise.resolve(body) } as unknown as Response;
}

function okFetcher(data: unknown) {
  return vi.fn().mockResolvedValue(jsonResponse({ ok: true, data }));
}

/** The seam's shape for a named refusal: a stable code plus `details.reason`. */
function refusalFetcher(reason: string, code = "CONFLICT", status = 409) {
  return vi.fn().mockResolvedValue(
    jsonResponse({ ok: false, error: { code, message: reason, details: { reason } } }, status),
  );
}

const authorityData = {
  contractVersion: "commerce.v0",
  scopeSlugs: ["first-item"],
  products: [
    {
      slug: "first-item",
      productId: "11111111-1111-4111-8111-111111111111",
      productStatus: "active",
      primarySkuId: null,
      skuCode: null,
      skuStatus: null,
      netContentGrams: null,
      sellableStandalone: null,
      sellableInSubscription: null,
      primaryTradeItemRef: "0000000000000",
      documentRevisionId: "22222222-2222-4222-8222-222222222222",
      revisionNo: 3,
      documentSchemaId: "schema-1",
      documentDigest: DIGEST_A,
    },
  ],
};

const proposalRequest: SubmitCatalogDocumentProposalRequest = {
  mode: "dry_run",
  baseDocumentDigests: [{ productSlug: "first-item", documentDigest: DIGEST_A }],
  candidate: {
    canonicalText: "{}",
    envelopeSha256: DIGEST_B,
    documents: [{ productSlug: "first-item", document: { title: "next" } }],
  },
};

describe("readCatalogDocumentAuthority", () => {
  it("GETs the document route with a bearer token and the optional slug", async () => {
    const fetcher = okFetcher(authorityData);
    const result = await readCatalogDocumentAuthority("admin-token", "first-item", { fetcher });

    const [url, init] = fetcher.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("/api/bff/admin/commerce/catalog/document?slug=first-item");
    expect(init.method).toBe("GET");
    expect((init.headers as Headers).get("Authorization")).toBe("Bearer admin-token");
    expect(result.products[0]?.documentDigest).toBe(DIGEST_A);
  });

  it("omits the query when no slug is asked for", async () => {
    const fetcher = okFetcher(authorityData);
    await readCatalogDocumentAuthority("admin-token", undefined, { fetcher });
    expect(fetcher.mock.calls[0]?.[0]).toBe("/api/bff/admin/commerce/catalog/document");
  });
});

describe("submitCatalogDocumentProposal", () => {
  it("POSTs the candidate to the proposal route and returns the diff", async () => {
    const fetcher = okFetcher({
      contractVersion: "commerce.v0",
      mode: "dry_run",
      candidateDigest: DIGEST_B,
      deltas: [{ productSlug: "first-item", path: "title", currentValue: "now", targetValue: "next" }],
      submitted: null,
    });

    const result = await submitCatalogDocumentProposal("admin-token", proposalRequest, { fetcher });

    const [url, init] = fetcher.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("/api/bff/admin/commerce/catalog/document-proposal");
    expect(init.method).toBe("POST");
    expect(JSON.parse(String(init.body))).toEqual(proposalRequest);
    expect(result.submitted).toBeNull();
    expect(result.deltas).toHaveLength(1);
  });
});

describe("named refusals", () => {
  it.each(CATALOG_DOCUMENT_REFUSALS)("re-raises %s as itself", async (refusal) => {
    const fetcher = refusalFetcher(refusal);
    const error = await submitCatalogDocumentProposal("admin-token", proposalRequest, { fetcher })
      .then(() => null, (thrown: unknown) => thrown);

    expect(error).toBeInstanceOf(CatalogDocumentAuthorityError);
    expect((error as CatalogDocumentAuthorityError).code).toBe(refusal);
    expect(catalogDocumentRefusalOf(error)).toBe(refusal);
  });

  it("re-raises a refusal the read route answers with", async () => {
    const fetcher = refusalFetcher("catalog_document_authority_unavailable", "UPSTREAM_UNAVAILABLE", 503);
    const error = await readCatalogDocumentAuthority("admin-token", undefined, { fetcher })
      .then(() => null, (thrown: unknown) => thrown);

    expect(catalogDocumentRefusalOf(error)).toBe("catalog_document_authority_unavailable");
  });

  it("leaves a submission-RPC token untouched instead of dressing it as a seam refusal", async () => {
    const fetcher = refusalFetcher("catalog_proposal_conflict");
    const error = await submitCatalogDocumentProposal("admin-token", proposalRequest, { fetcher })
      .then(() => null, (thrown: unknown) => thrown);

    expect(error).toBeInstanceOf(BffClientError);
    expect(error).not.toBeInstanceOf(CatalogDocumentAuthorityError);
    expect((error as BffClientError).details).toEqual({ reason: "catalog_proposal_conflict" });
    expect(catalogDocumentRefusalOf(error)).toBeNull();
  });

  it("reports no refusal for an error that carries none", () => {
    expect(catalogDocumentRefusalOf(new Error("network down"))).toBeNull();
    expect(catalogDocumentRefusalOf(null)).toBeNull();
  });
});

describe("publishCatalogDocumentCandidate", () => {
  function rpcClient(responses: Record<string, unknown>): {
    client: CatalogPublicationRpcClient;
    rpc: ReturnType<typeof vi.fn>;
  } {
    const rpc = vi.fn((name: string) => Promise.resolve({ data: responses[name] ?? null, error: null }));
    return { client: { rpc } as unknown as CatalogPublicationRpcClient, rpc };
  }

  it("approves and then publishes on the caller's own session, with derived command keys", async () => {
    const { client, rpc } = rpcClient({
      catalog_record_publication_decision: { decisionId: "decision-1", replayed: false },
      catalog_publish_candidate: { eventId: "event-1", postDigest: DIGEST_B, replayed: false },
    });

    const result = await publishCatalogDocumentCandidate(client, {
      candidateId: "candidate-1",
      candidateDigest: DIGEST_A,
      expectedCurrentDigest: DIGEST_B,
    });

    expect(rpc.mock.calls.map((call) => call[0])).toEqual([
      "catalog_record_publication_decision",
      "catalog_publish_candidate",
    ]);
    expect(rpc.mock.calls[0]?.[1]).toEqual({
      p_candidate_id: "candidate-1",
      p_candidate_digest: DIGEST_A,
      p_decision: "approve",
      p_command_key: `catalog-document-panel:candidate-1:${DIGEST_A}:approve`,
    });
    expect(rpc.mock.calls[1]?.[1]).toEqual({
      p_candidate_id: "candidate-1",
      p_expected_current_digest: DIGEST_B,
      p_command_key: `catalog-document-panel:candidate-1:${DIGEST_A}:publish`,
    });
    expect(result).toEqual({
      decisionId: "decision-1",
      decisionReplayed: false,
      eventId: "event-1",
      postDigest: DIGEST_B,
      publicationReplayed: false,
    });
  });

  it("carries the raised token, and never reaches publish when the decision is refused", async () => {
    const rpc = vi.fn(() =>
      Promise.resolve({ data: null, error: { code: "42501", message: "catalog_publication_human_admin_required" } }));
    const client = { rpc } as unknown as CatalogPublicationRpcClient;

    const error = await publishCatalogDocumentCandidate(client, {
      candidateId: "candidate-1",
      candidateDigest: DIGEST_A,
      expectedCurrentDigest: DIGEST_B,
    }).then(() => null, (thrown: unknown) => thrown);

    expect(error).toBeInstanceOf(CatalogPublicationRpcError);
    expect((error as CatalogPublicationRpcError).reason).toBe("catalog_publication_human_admin_required");
    expect(rpc).toHaveBeenCalledTimes(1);
  });
});
