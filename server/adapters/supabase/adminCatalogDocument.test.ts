import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";

import { DomainRpcError } from "../../_lib/admin-domain/rpcErrors.js";
import {
  createSupabaseAdminCatalogDocumentDataPort,
  type CatalogDocumentDataClient,
} from "./adminCatalogDocument.js";
import { CatalogDocumentAuthorityError } from "../../../src/domains/commerce/adminCatalogDocumentContracts.js";

const CANONICAL_TEXT = '{"proposal":"candidate"}';
const CANDIDATE_DIGEST = createHash("sha256").update(CANONICAL_TEXT, "utf8").digest("hex");
const OTHER_DIGEST = "b".repeat(64);
const REVISION_DIGEST = "c".repeat(64);

const productId = "11111111-1111-4111-8111-111111111111";
const skuId = "22222222-2222-4222-8222-222222222222";
const revisionId = "33333333-3333-4333-8333-333333333333";

interface Call { table: string; filters: string[] }

function stubClient(tables: Record<string, unknown[]>, rpc = vi.fn()) {
  const calls: Call[] = [];
  const client = {
    from: (table: string) => {
      const call: Call = { table, filters: [] };
      calls.push(call);
      const chain: Record<string, unknown> = {
        select: () => chain,
        eq: (column: string) => { call.filters.push(`eq:${column}`); return chain; },
        in: (column: string) => { call.filters.push(`in:${column}`); return chain; },
        not: (column: string, operator: string) => { call.filters.push(`not:${column}:${operator}`); return chain; },
        order: (column: string) => { call.filters.push(`order:${column}`); return chain; },
        limit: (count: number) => { call.filters.push(`limit:${count}`); return chain; },
        then: (resolve: (value: { data: unknown[]; error: null }) => unknown) =>
          Promise.resolve({ data: tables[table] ?? [], error: null }).then(resolve),
      };
      return chain;
    },
    rpc,
  } as unknown as CatalogDocumentDataClient;
  return { client, rpc, calls };
}

const POPULATED: Record<string, unknown[]> = {
  catalog_products: [{
    id: productId, slug: "alpha", status: "active",
    primary_sku_id: skuId, current_document_revision_id: revisionId,
  }],
  catalog_skus: [{
    id: skuId, sku: "ALPHA-400", status: "active", net_weight_g: 400,
    sellable_standalone: true, sellable_in_subscription: true,
  }],
  catalog_sku_eans: [{ catalog_sku_id: skuId, ean: "5901234123457" }],
  catalog_product_document_revisions: [{
    id: revisionId, product_id: productId, revision_no: 2,
    schema_id: "example.product-document.v1",
    document_payload: { energy: { unscaled: 123 } }, digest: REVISION_DIGEST,
  }],
};

describe("catalog document data port", () => {
  it("derives the scope from the products that carry a document pointer", async () => {
    const stub = stubClient(POPULATED);
    const read = await createSupabaseAdminCatalogDocumentDataPort(stub.client).readAuthority();

    expect(read.scopeSlugs).toEqual(["alpha"]);
    const productRead = stub.calls.find((call) => call.table === "catalog_products");
    expect(productRead?.filters).toContain("not:current_document_revision_id:is");
    // Ordered BEFORE limited: an unordered page truncates non-deterministically.
    expect(productRead?.filters.indexOf("order:slug")).toBeGreaterThanOrEqual(0);
    expect(productRead?.filters.indexOf("order:slug"))
      .toBeLessThan(productRead!.filters.findIndex((filter) => filter.startsWith("limit:")));
  });

  it("reads the revision facts through the shared current-document port", async () => {
    const read = await createSupabaseAdminCatalogDocumentDataPort(stubClient(POPULATED).client).readAuthority();

    expect(read.products[0]).toMatchObject({
      slug: "alpha",
      productId,
      primarySkuId: skuId,
      skuCode: "ALPHA-400",
      netContentGrams: 400,
      primaryTradeItemRef: "5901234123457",
      documentRevisionId: revisionId,
      revisionNo: 2,
      documentSchemaId: "example.product-document.v1",
      documentDigest: REVISION_DIGEST,
    });
    expect(read.documents.get("alpha")).toEqual({ energy: { unscaled: 123 } });
  });

  it("answers an empty scope rather than refusing when no product carries a pointer", async () => {
    const read = await createSupabaseAdminCatalogDocumentDataPort(stubClient({}).client).readAuthority();
    expect(read).toMatchObject({ scopeSlugs: [], products: [] });
  });

  it("refuses by name when a pointer resolves to no readable revision", async () => {
    const port = createSupabaseAdminCatalogDocumentDataPort(stubClient({
      ...POPULATED,
      catalog_product_document_revisions: [],
    }).client);

    await expect(port.readAuthority()).rejects.toBeInstanceOf(CatalogDocumentAuthorityError);
  });

  it("submits through the change-proposal RPC and maps its RAISE to a typed error", async () => {
    const ok = vi.fn().mockResolvedValue({
      data: [{
        proposal_id: "p1", proposal_sha256: OTHER_DIGEST,
        envelope_sha256: CANDIDATE_DIGEST, inserted: true,
      }],
      error: null,
    });
    const port = createSupabaseAdminCatalogDocumentDataPort(stubClient({}, ok).client);
    await expect(port.submitChangeProposal(CANONICAL_TEXT, CANDIDATE_DIGEST)).resolves.toMatchObject({
      proposalId: "p1",
      inserted: true,
    });
    expect(ok).toHaveBeenCalledWith("catalog_submit_change_proposal", {
      p_canonical_text: CANONICAL_TEXT,
      p_envelope_sha256: CANDIDATE_DIGEST,
    });

    const failing = vi.fn().mockResolvedValue({
      data: null,
      error: { code: "22023", message: "catalog_proposal_base_digest_mismatch" },
    });
    await expect(createSupabaseAdminCatalogDocumentDataPort(stubClient({}, failing).client)
      .submitChangeProposal(CANONICAL_TEXT, CANDIDATE_DIGEST)).rejects.toBeInstanceOf(DomainRpcError);
  });
});

/**
 * Unit tests stub the client, so a table this role cannot read looks identical
 * to one it can. These three are `REVOKE ALL ... FROM ... service_role` in
 * `20260828220001_catalog_document_publication_control.sql`, so any select
 * against them from this adapter is unreachable code that only a real database
 * would reject.
 *
 * The privilege half of that claim - which tables this role can and cannot read -
 * is asserted against a real database in
 * `supabase/tests/catalog_document_seam_grants_test.sql`. What stays here is the
 * source-shape half: that this module does not reach for them in the first place.
 */
const REVOKED_TABLES = [
  "catalog_publication_candidates",
  "catalog_publication_decisions",
  "catalog_publication_events",
] as const;

describe("tables the service role cannot read", () => {
  // Comments stripped first: this module DOCUMENTS why it avoids these names,
  // and a guard that trips on its own explanation teaches nothing.
  const source = readFileSync("server/adapters/supabase/adminCatalogDocument.ts", "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^[ \t]*\/\/.*$/gm, "");

  it("never selects from a publication ledger revoked from the role it runs as", () => {
    for (const table of REVOKED_TABLES) {
      expect(source, `${table} is revoked from service_role`)
        .not.toMatch(new RegExp(`from\\(\\s*["'\`]${table}`));
    }
  });

  it("never calls the current-state resolver, which is not SECURITY DEFINER", () => {
    expect(source).not.toContain("catalog_publication_current_state");
  });

  it("uses no PostgREST embed between products and revisions, which carry two foreign keys", () => {
    // An embed is a parenthesised column group. Two FKs between this pair means
    // any unhinted embed fails PGRST201, and `!inner` is not a hint.
    const selected = [...source.matchAll(/(?:const \w+_COLUMNS = |\.select\()\s*"([^"]*)"/g)]
      .map((match) => match[1]!);
    expect(selected.length).toBeGreaterThan(0);
    for (const columns of selected) expect(columns, columns).not.toContain("(");
    expect(source).not.toContain("!inner");
  });
});
