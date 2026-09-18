import { describe, expect, it, vi } from "vitest";

import type { VercelRequest, VercelResponse } from "../../_lib/types/vercel.js";
import {
  COMMERCE_PRODUCT_COMPATIBILITY_CONTRACT_VERSION,
  type CommerceProductCompatibilityResponse,
} from "../../../src/domains/commerce/productCompatibilityContracts.js";
import type { CommerceProductCompatibilityPort } from "../../../src/domains/commerce/ports.js";
import { createCommerceProductCompatibilityHandler } from "./commerceProductCompatibilityHandler.js";
import { CatalogRecommendationVariantReadError } from "./catalogRecommendationVariants.js";

describe("commerce product compatibility handler", () => {
  it("returns product compatibility through the shared envelope", async () => {
    const port = createPort();
    const res = createResponse();

    await createCommerceProductCompatibilityHandler({ productCompatibilityPort: port })(
      request("POST", { allergenSlugs: ["chicken"] }),
      res,
    );

    expect(port.getCompatibility).toHaveBeenCalledWith({ allergenSlugs: ["chicken"] });
    expect(res.status).toHaveBeenCalledWith(200);
    expect(res.json).toHaveBeenCalledWith({
      ok: true,
      data: compatibilityResponse(),
      meta: { contractVersion: COMMERCE_PRODUCT_COMPATIBILITY_CONTRACT_VERSION },
    });
  });

  it("maps invalid requests and catalog failures fail-closed", async () => {
    // Open value space: a well-formed unknown slug is accepted; only a MALFORMED
    // slug is a validation error (400).
    const invalid = createResponse();
    await createCommerceProductCompatibilityHandler({
      productCompatibilityPort: createPort(),
    })(request("POST", { allergenSlugs: ["Not a slug!"] }), invalid);

    const upstream = createResponse();
    await createCommerceProductCompatibilityHandler({
      productCompatibilityPort: createPort(new Error("catalog unavailable")),
    })(request("POST", { allergenSlugs: [] }), upstream);

    expect(invalid.status).toHaveBeenCalledWith(400);
    expect(upstream.status).toHaveBeenCalledWith(503);
  });

  it.each([
    "catalog_read_not_configured",
    "catalog_authority_unavailable",
    "catalog_authority_changed",
    "catalog_revision_invalid",
    "catalog_document_schema_invalid",
    "catalog_document_digest_mismatch",
    "catalog_primary_trade_item_invalid",
  ] as const)("maps bounded catalog refusal %s without falling back", async (refusalCode) => {
    const res = createResponse();
    await createCommerceProductCompatibilityHandler({
      productCompatibilityPort: createPort(new CatalogRecommendationVariantReadError(refusalCode)),
    })(request("POST", { allergenSlugs: [] }), res);

    expect(res.status).toHaveBeenCalledWith(503);
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({
      ok: false,
      error: expect.objectContaining({
        code: "UPSTREAM_UNAVAILABLE",
        details: { reason: "catalog_unavailable", refusalCode },
      }),
    }));
  });
});

function createPort(result?: unknown): CommerceProductCompatibilityPort {
  return {
    getCompatibility: vi.fn().mockImplementation(async () => {
      if (result instanceof Error) throw result;
      return (result as CommerceProductCompatibilityResponse | undefined) ??
        compatibilityResponse();
    }),
  };
}

function compatibilityResponse(): CommerceProductCompatibilityResponse {
  return {
    contractVersion: COMMERCE_PRODUCT_COMPATIBILITY_CONTRACT_VERSION,
    products: [
      {
        variantId: "variant-turkey-400",
        sku: "opaque:turkey-launch.v1",
        slug: "turkey",
        selectable: true,
        conflictAllergenSlugs: [],
      },
      {
        variantId: "variant-salmon-400",
        sku: "opaque:salmon-launch.v1",
        slug: "salmon",
        selectable: false,
        conflictAllergenSlugs: ["chicken"],
      },
    ],
  };
}

function request(method: string, body?: unknown): VercelRequest {
  return { method, body, query: {} } as unknown as VercelRequest;
}

function createResponse(): VercelResponse {
  const res = { setHeader: vi.fn(), status: vi.fn(), json: vi.fn() } as unknown as VercelResponse;
  vi.mocked(res.status).mockReturnValue(res);
  vi.mocked(res.json).mockReturnValue(res);
  return res;
}
