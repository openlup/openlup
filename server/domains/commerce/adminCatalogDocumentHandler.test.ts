import { createHash } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";

import type { VercelRequest, VercelResponse } from "../../_lib/types/vercel.js";
import { DomainRpcError } from "../../_lib/admin-domain/rpcErrors.js";
import {
  createAdminCatalogDocumentAuthorityHandler,
  createAdminCatalogDocumentProposalHandler,
  type AdminCatalogDocumentHandlerDeps,
} from "./adminCatalogDocumentHandler.js";
import {
  CatalogDocumentAuthorityError,
  createCatalogDocumentDiff,
  type AdminCatalogDocumentDataPort,
  type CatalogDocumentAuthorityRead,
} from "../../../src/domains/commerce/adminCatalogDocumentContracts.js";
import { catalogSpec } from "../../../src/domains/commerce/catalogSpec.js";

const CANONICAL_TEXT = '{"proposal":"candidate"}';
const CANDIDATE_DIGEST = createHash("sha256").update(CANONICAL_TEXT, "utf8").digest("hex");
const OTHER_DIGEST = "b".repeat(64);
const REVISION_DIGEST = "c".repeat(64);

function createResponse(): VercelResponse {
  const res = { setHeader: vi.fn(), status: vi.fn(), json: vi.fn() } as unknown as VercelResponse;
  vi.mocked(res.status).mockReturnValue(res);
  return res;
}

function request(method: string, payload: Record<string, unknown> = {}): VercelRequest {
  return { method, headers: {}, query: payload, body: payload } as unknown as VercelRequest;
}

function body(res: VercelResponse): Record<string, unknown> {
  return vi.mocked(res.json).mock.calls.at(-1)?.[0] as Record<string, unknown>;
}

function authority(overrides: Partial<CatalogDocumentAuthorityRead> = {}): CatalogDocumentAuthorityRead {
  return {
    scopeSlugs: ["alpha", "bravo"],
    products: [
      {
        slug: "alpha",
        productId: "11111111-1111-4111-8111-111111111111",
        productStatus: "active",
        primarySkuId: "22222222-2222-4222-8222-222222222222",
        skuCode: "ALPHA-400",
        skuStatus: "active",
        netContentGrams: 400,
        sellableStandalone: true,
        sellableInSubscription: true,
        primaryTradeItemRef: "5901234123457",
        documentRevisionId: "33333333-3333-4333-8333-333333333333",
        revisionNo: 2,
        documentSchemaId: "example.product-document.v1",
        documentDigest: REVISION_DIGEST,
      },
    ],
    documents: new Map([["alpha", { energy: { unscaled: 123 } }]]),
    ...overrides,
  };
}

function deps(overrides: Partial<AdminCatalogDocumentHandlerDeps> = {}): AdminCatalogDocumentHandlerDeps {
  const dataPort: AdminCatalogDocumentDataPort = {
    readAuthority: vi.fn().mockResolvedValue(authority()),
    submitChangeProposal: vi.fn().mockResolvedValue({
      proposalId: "proposal-1",
      proposalSha256: OTHER_DIGEST,
      envelopeSha256: CANDIDATE_DIGEST,
      inserted: true,
    }),
  };
  return {
    dataPort,
    authorizeAdmin: async () => ({ ok: true, userId: "admin-1", role: "admin", isMachineActor: false }),
    ...overrides,
  };
}

function proposal(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    mode: "dry_run",
    baseDocumentDigests: [{ productSlug: "alpha", documentDigest: REVISION_DIGEST }],
    candidate: { canonicalText: CANONICAL_TEXT, envelopeSha256: CANDIDATE_DIGEST, documents: [] },
    ...overrides,
  };
}

/** `dry_run` fails closed without one, so most cases bind a permissive validator. */
function validating(overrides: Partial<AdminCatalogDocumentHandlerDeps> = {}): AdminCatalogDocumentHandlerDeps {
  return deps({ validateDocument: () => undefined, ...overrides });
}

describe("catalog document authority read handler", () => {
  it("rejects a non-GET method (405)", async () => {
    const res = createResponse();
    await createAdminCatalogDocumentAuthorityHandler(deps())(request("POST"), res);
    expect(res.status).toHaveBeenCalledWith(405);
  });

  it("rejects an unauthenticated caller (401)", async () => {
    const res = createResponse();
    await createAdminCatalogDocumentAuthorityHandler(deps({
      authorizeAdmin: async () => ({ ok: false, code: "UNAUTHORIZED", message: "Admin session required" }),
    }))(request("GET"), res);
    expect(res.status).toHaveBeenCalledWith(401);
  });

  it("answers with the revision facts and the aggregate state digest", async () => {
    const res = createResponse();
    await createAdminCatalogDocumentAuthorityHandler(deps())(request("GET"), res);
    const data = body(res).data as Record<string, unknown>;
    expect(body(res).ok).toBe(true);
    expect(data.stateDigest).toBeUndefined();
    expect(data.scopeSlugs).toEqual(["alpha", "bravo"]);
    expect((data.products as Array<Record<string, unknown>>)[0]).toMatchObject({
      slug: "alpha",
      revisionNo: 2,
      documentDigest: REVISION_DIGEST,
      primarySkuId: "22222222-2222-4222-8222-222222222222",
      skuCode: "ALPHA-400",
      netContentGrams: 400,
    });
  });

  it("passes a slug filter through to the data port", async () => {
    const handlerDeps = deps();
    await createAdminCatalogDocumentAuthorityHandler(handlerDeps)(request("GET", { slug: "alpha" }), createResponse());
    expect(handlerDeps.dataPort.readAuthority).toHaveBeenCalledWith("alpha");
  });

  it("refuses an unreadable authority by name rather than generically", async () => {
    const res = createResponse();
    await createAdminCatalogDocumentAuthorityHandler(deps({
      dataPort: {
        readAuthority: vi.fn().mockRejectedValue(new CatalogDocumentAuthorityError("catalog_document_authority_unavailable")),
        submitChangeProposal: vi.fn(),
      },
    }))(request("GET"), res);
    expect(body(res)).toMatchObject({
      ok: false,
      error: { details: { reason: "catalog_document_authority_unavailable" } },
    });
  });
});

describe("catalog document proposal handler", () => {
  it("rejects a non-POST method (405)", async () => {
    const res = createResponse();
    await createAdminCatalogDocumentProposalHandler(validating())(request("GET", proposal()), res);
    expect(res.status).toHaveBeenCalledWith(405);
  });

  it("rejects an unauthenticated caller (401)", async () => {
    const res = createResponse();
    await createAdminCatalogDocumentProposalHandler(validating({
      authorizeAdmin: async () => ({ ok: false, code: "UNAUTHORIZED", message: "Admin session required" }),
    }))(request("POST", proposal()), res);
    expect(res.status).toHaveBeenCalledWith(401);
  });

  it("admits a machine actor: proposing is an inbox write, never a publication", async () => {
    const res = createResponse();
    await createAdminCatalogDocumentProposalHandler(validating({
      authorizeAdmin: async () => ({ ok: true, userId: "agent-1", role: "admin", isMachineActor: true }),
    }))(request("POST", proposal()), res);
    expect(body(res).ok).toBe(true);
    expect(catalogSpec.mutations.proposeDocument?.allowedActorKinds).toEqual(["human", "machine"]);
  });

  it("refuses a candidate whose declared digest is not its own bytes", async () => {
    const res = createResponse();
    const handlerDeps = validating();
    await createAdminCatalogDocumentProposalHandler(handlerDeps)(
      request("POST", proposal({
        candidate: { canonicalText: CANONICAL_TEXT, envelopeSha256: OTHER_DIGEST, documents: [] },
      })),
      res,
    );
    expect(body(res)).toMatchObject({
      ok: false,
      error: { details: { reason: "catalog_document_candidate_digest_mismatch" } },
    });
    expect(handlerDeps.dataPort.submitChangeProposal).not.toHaveBeenCalled();
  });

  it("refuses a stale per-product base digest by name instead of rebasing it", async () => {
    const res = createResponse();
    const handlerDeps = validating();
    await createAdminCatalogDocumentProposalHandler(handlerDeps)(
      request("POST", proposal({
        mode: "commit",
        baseDocumentDigests: [{ productSlug: "alpha", documentDigest: OTHER_DIGEST }],
      })),
      res,
    );
    expect(body(res)).toMatchObject({
      ok: false,
      error: { details: { reason: "catalog_document_stale_base_digest" } },
    });
    expect(handlerDeps.dataPort.submitChangeProposal).not.toHaveBeenCalled();
  });

  it("refuses a candidate document outside the publication scope", async () => {
    const res = createResponse();
    await createAdminCatalogDocumentProposalHandler(validating())(
      request("POST", proposal({
        candidate: {
          canonicalText: CANONICAL_TEXT,
          envelopeSha256: CANDIDATE_DIGEST,
          documents: [{ productSlug: "charlie", document: {} }],
        },
      })),
      res,
    );
    expect(body(res)).toMatchObject({
      ok: false,
      error: { details: { reason: "catalog_document_scope_unknown" } },
    });
  });

  it("refuses a candidate the injected deployment validator rejects", async () => {
    const res = createResponse();
    const handlerDeps = deps({
      validateDocument: () => {
        throw new Error("document schema rejected the candidate");
      },
    });
    await createAdminCatalogDocumentProposalHandler(handlerDeps)(
      request("POST", proposal({
        candidate: {
          canonicalText: CANONICAL_TEXT,
          envelopeSha256: CANDIDATE_DIGEST,
          documents: [{ productSlug: "alpha", document: { energy: { unscaled: 121 } } }],
        },
      })),
      res,
    );
    expect(res.status).toHaveBeenCalledWith(400);
    expect(body(res)).toMatchObject({
      ok: false,
      error: { details: { reason: "catalog_document_candidate_invalid" } },
    });
    expect(handlerDeps.dataPort.submitChangeProposal).not.toHaveBeenCalled();
  });

  it("dry_run diffs against the current revision and writes nothing", async () => {
    const res = createResponse();
    const handlerDeps = validating();
    await createAdminCatalogDocumentProposalHandler(handlerDeps)(
      request("POST", proposal({
        candidate: {
          canonicalText: CANONICAL_TEXT,
          envelopeSha256: CANDIDATE_DIGEST,
          documents: [{ productSlug: "alpha", document: { energy: { unscaled: 121 } } }],
        },
      })),
      res,
    );
    const data = body(res).data as Record<string, unknown>;
    expect(data.mode).toBe("dry_run");
    expect(data.candidateDigest).toBe(CANDIDATE_DIGEST);
    expect(data.submitted).toBeNull();
    expect(data.deltas).toEqual([
      { productSlug: "alpha", path: "energy.unscaled", currentValue: 123, targetValue: 121 },
    ]);
    expect(handlerDeps.dataPort.submitChangeProposal).not.toHaveBeenCalled();
  });

  it("commit submits the exact bytes and returns the stored envelope digest", async () => {
    const res = createResponse();
    const handlerDeps = validating();
    await createAdminCatalogDocumentProposalHandler(handlerDeps)(
      request("POST", proposal({ mode: "commit" })),
      res,
    );
    expect(handlerDeps.dataPort.submitChangeProposal).toHaveBeenCalledWith(CANONICAL_TEXT, CANDIDATE_DIGEST);
    expect((body(res).data as Record<string, unknown>).submitted).toMatchObject({
      proposalId: "proposal-1",
      envelopeSha256: CANDIDATE_DIGEST,
      inserted: true,
    });
  });

  it("fails closed: dry_run refuses when no deployment validator is bound", async () => {
    const res = createResponse();
    const handlerDeps = deps();
    await createAdminCatalogDocumentProposalHandler(handlerDeps)(request("POST", proposal()), res);
    expect(res.status).toHaveBeenCalledWith(503);
    expect(body(res)).toMatchObject({
      ok: false,
      error: { details: { reason: "catalog_document_validation_unavailable" } },
    });
    expect(handlerDeps.dataPort.readAuthority).not.toHaveBeenCalled();
    expect(handlerDeps.dataPort.submitChangeProposal).not.toHaveBeenCalled();
  });

  it("commit still proceeds without a bound validator: the submission RPC is a real authority", async () => {
    const res = createResponse();
    const handlerDeps = deps();
    await createAdminCatalogDocumentProposalHandler(handlerDeps)(
      request("POST", proposal({ mode: "commit" })),
      res,
    );
    expect(body(res).ok).toBe(true);
    expect(handlerDeps.dataPort.submitChangeProposal).toHaveBeenCalled();
  });

  it("refuses a candidate rewriting a product whose freshness was never declared", async () => {
    const res = createResponse();
    const handlerDeps = validating();
    await createAdminCatalogDocumentProposalHandler(handlerDeps)(
      request("POST", proposal({
        mode: "commit",
        // Declares freshness for alpha, rewrites bravo: without the coverage
        // check the freshness assertion passes vacuously.
        baseDocumentDigests: [{ productSlug: "alpha", documentDigest: REVISION_DIGEST }],
        candidate: {
          canonicalText: CANONICAL_TEXT,
          envelopeSha256: CANDIDATE_DIGEST,
          documents: [{ productSlug: "bravo", document: { energy: { unscaled: 1 } } }],
        },
      })),
      res,
    );
    expect(body(res)).toMatchObject({
      ok: false,
      error: { details: { reason: "catalog_document_stale_base_digest" } },
    });
    expect(handlerDeps.dataPort.submitChangeProposal).not.toHaveBeenCalled();
  });

  it("maps caller mistakes to 400 and a live-revision race to 409", async () => {
    const mismatch = createResponse();
    await createAdminCatalogDocumentProposalHandler(validating())(
      request("POST", proposal({
        candidate: { canonicalText: CANONICAL_TEXT, envelopeSha256: OTHER_DIGEST, documents: [] },
      })),
      mismatch,
    );
    expect(mismatch.status).toHaveBeenCalledWith(400);

    const unknownScope = createResponse();
    await createAdminCatalogDocumentProposalHandler(validating())(
      request("POST", proposal({
        baseDocumentDigests: [{ productSlug: "charlie", documentDigest: REVISION_DIGEST }],
      })),
      unknownScope,
    );
    expect(unknownScope.status).toHaveBeenCalledWith(400);

    const stale = createResponse();
    await createAdminCatalogDocumentProposalHandler(validating())(
      request("POST", proposal({
        baseDocumentDigests: [{ productSlug: "alpha", documentDigest: OTHER_DIGEST }],
      })),
      stale,
    );
    expect(stale.status).toHaveBeenCalledWith(409);
  });

  it("keeps the inbox conflict's RAISEd name instead of flattening it to already_exists", async () => {
    const res = createResponse();
    await createAdminCatalogDocumentProposalHandler(validating({
      dataPort: {
        readAuthority: vi.fn().mockResolvedValue(authority()),
        submitChangeProposal: vi.fn().mockRejectedValue(
          new DomainRpcError("23505", "catalog_proposal_conflict"),
        ),
      },
    }))(request("POST", proposal({ mode: "commit" })), res);
    expect(res.status).toHaveBeenCalledWith(409);
    expect(body(res)).toMatchObject({
      ok: false,
      error: { details: { reason: "catalog_proposal_conflict" } },
    });
  });

  it("carries a submission RPC refusal through by its own name", async () => {
    const res = createResponse();
    await createAdminCatalogDocumentProposalHandler(validating({
      dataPort: {
        readAuthority: vi.fn().mockResolvedValue(authority()),
        submitChangeProposal: vi.fn().mockRejectedValue(
          new DomainRpcError("22023", "catalog_proposal_exact_scope_invalid"),
        ),
      },
    }))(request("POST", proposal({ mode: "commit" })), res);
    expect(res.status).toHaveBeenCalledWith(409);
    expect(body(res)).toMatchObject({
      ok: false,
      error: { details: { reason: "catalog_proposal_exact_scope_invalid" } },
    });
  });
});

/**
 * Every neutral seam module read once, by a LITERAL path. Two reasons, both
 * load-bearing. A `readFileSync` over a path built at runtime is recorded as an
 * opaque source-dependency edge in `config/oss-core-readiness-blockers.json`,
 * and that receipt is a control-plane path - which would demand a hosted-canary
 * proof from a wave that changes no control. And a literal path is checked by
 * the publication closure, which is why the OVERLAY halves of this seam are
 * pinned from inside the overlay instead
 * (`server/bff/overlay/catalog-admin-document.test.ts`): this file is published,
 * the overlay roots are withheld, and a published file may not name a withheld
 * path.
 */
const SEAM_SOURCES: Record<string, string> = {
  "src/domains/commerce/adminCatalogDocumentContracts.ts":
    readFileSync("src/domains/commerce/adminCatalogDocumentContracts.ts", "utf8"),
  "server/domains/commerce/adminCatalogDocumentHandler.ts":
    readFileSync("server/domains/commerce/adminCatalogDocumentHandler.ts", "utf8"),
  "server/adapters/supabase/adminCatalogDocument.ts":
    readFileSync("server/adapters/supabase/adminCatalogDocument.ts", "utf8"),
  "src/domains/commerce/adminCatalogDocumentClient.ts":
    readFileSync("src/domains/commerce/adminCatalogDocumentClient.ts", "utf8"),
};

describe("the publication boundary this wave must not cross", () => {
  const HUMAN_ONLY_RPCS = [
    "catalog_publish_candidate",
    "catalog_record_publication_decision",
    "catalog_rollback_publication",
  ] as const;

  /**
   * Literal paths, but not a trusted list: the assertion below compares them
   * against the real directory listing, so a fourth neutral seam module still
   * turns this file red rather than escaping the pins by not being named here.
   * `readdirSync` on a literal directory is statically resolvable; reading a
   * path built from its result is not.
   */
  const NEUTRAL_SEAM = [
    "src/domains/commerce/adminCatalogDocumentContracts.ts",
    "server/domains/commerce/adminCatalogDocumentHandler.ts",
    "server/adapters/supabase/adminCatalogDocument.ts",
  ] as const;

  /**
   * The one module of this seam that deliberately DOES name the human-only
   * publication RPCs, and the reason the inventory below is a union of two lists
   * rather than one. W3f-b added it: publication is called on the operator's own
   * browser session through an injected port, precisely because a BFF route
   * reaching those RPCs would arrive as the service role with `auth.uid() = NULL`
   * and launder a machine actor through a human-only gate. The exemption is
   * therefore asserted, not assumed - see the two cases at the end of this
   * block, which fail if this file stops carrying the act or starts carrying its
   * own session client.
   */
  const BROWSER_SESSION_SEAM = ["src/domains/commerce/adminCatalogDocumentClient.ts"] as const;

  const NEUTRAL_DIRECTORIES = [
    "src/domains/commerce",
    "server/domains/commerce",
    "server/adapters/supabase",
  ] as const;

  const sourceOf = (file: string): string => {
    // An empty file satisfies every `not.toContain`, so prove there is source here.
    const source = SEAM_SOURCES[file];
    expect(source, `${file} was not read`).toBeTypeOf("string");
    expect(source!.trim().length, `${file} is empty`).toBeGreaterThan(0);
    return source!;
  };

  it("names every neutral seam module the directories actually hold", () => {
    const listed = NEUTRAL_DIRECTORIES.flatMap((directory) => readdirSync(directory)
      .filter((entry) => /^adminCatalogDocument.*\.ts$/.test(entry) && !entry.endsWith(".test.ts"))
      .map((entry) => `${directory}/${entry}`));

    expect(listed.sort()).toEqual([...NEUTRAL_SEAM, ...BROWSER_SESSION_SEAM].sort());
  });

  it("keeps the browser module the only carrier of the human-only act", () => {
    for (const file of BROWSER_SESSION_SEAM) {
      const source = sourceOf(file);
      for (const rpc of ["catalog_record_publication_decision", "catalog_publish_candidate"]) {
        // A positive control, and the quotes are the control. `toContain(rpc)` is
        // satisfied by the doc comment above the port and by any renamed
        // superstring, so it would pass on a file that no longer calls anything;
        // the quoted literal is only there when the RPC is actually named as an
        // argument. If publication moves off the operator's session, the
        // exemption above is stale and has to be re-decided, not inherited.
        expect(source, `${file} must still carry ${rpc} on the operator session`)
          .toContain(`"${rpc}"`);
      }
      // Injected port, never its own client: a module that constructs a session
      // here could pick the service role and defeat the same gate a route would.
      expect(source, `${file} must not construct its own persistence client`)
        .not.toMatch(/from\s+"@supabase\//);
      expect(source, `${file} must not import a deployment overlay module`)
        .not.toMatch(/from\s+"[^"]*overlays\//);
    }
  });

  it("never names a human-only publication RPC in the neutral seam", () => {
    for (const file of NEUTRAL_SEAM) {
      const source = sourceOf(file);
      for (const rpc of HUMAN_ONLY_RPCS) {
        expect(source, `${file} must not reach ${rpc}`).not.toContain(rpc);
      }
    }
  });

  it("imports no deployment overlay module into the counted neutral half", () => {
    for (const file of NEUTRAL_SEAM) {
      expect(sourceOf(file), `${file} must not import a deployment overlay module`)
        .not.toMatch(/from\s+"[^"]*overlays\//);
    }
  });

  // The mirror of this - that the overlay roots DO bind the deployment halves -
  // is pinned in `server/bff/overlay/catalog-admin-document.test.ts`, which is
  // withheld alongside the roots it reads.
});

describe("the neutral diff engine", () => {
  it("keys array members by identity so a reorder is not read as a rewrite", () => {
    const diff = createCatalogDocumentDiff();
    expect(diff("alpha", "", [{ id: "x", v: 1 }, { id: "y", v: 2 }], [{ id: "y", v: 2 }, { id: "x", v: 1 }])).toEqual([]);
    expect(diff("alpha", "", { a: 1 }, { a: 2 })).toEqual([
      { productSlug: "alpha", path: "a", currentValue: 1, targetValue: 2 },
    ]);
    expect(diff("alpha", "example", null, undefined)).toEqual([
      { productSlug: "alpha", path: "example", currentValue: null, targetValue: { $absent: true } },
    ]);
  });
});
