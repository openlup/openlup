import { describe, expect, it, vi } from "vitest";
import type { VercelResponse } from "../../_lib/types/vercel.js";

import { COMMERCE_OFFER_LAYOUT_CONTRACT_VERSION } from "../../../src/domains/commerce/offerLayoutContracts.js";
import {
  COMMERCE_OFFER_LAYOUT_CACHE_CONTROL,
  createCommerceOfferLayoutHandler,
} from "./commerceOfferLayoutHandler.js";

describe("commerce offer layout handler", () => {
  it("returns the stored layout with the short shared-cache header", async () => {
    const res = createResponse();
    await createCommerceOfferLayoutHandler({
      readConfiguratorOfferLayout: async () => "starter_first",
    })({ method: "GET" } as never, res);

    expect(res.status).toHaveBeenCalledWith(200);
    expect(res.setHeader).toHaveBeenCalledWith(
      "Cache-Control",
      COMMERCE_OFFER_LAYOUT_CACHE_CONTROL,
    );
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({
      ok: true,
      data: {
        contractVersion: COMMERCE_OFFER_LAYOUT_CONTRACT_VERSION,
        layout: "starter_first",
      },
      meta: { contractVersion: COMMERCE_OFFER_LAYOUT_CONTRACT_VERSION },
    }));
  });

  it("rejects a non-GET method without reading the setting", async () => {
    const res = createResponse();
    const readConfiguratorOfferLayout = vi.fn(async () => "one_time_first" as const);
    await createCommerceOfferLayoutHandler({ readConfiguratorOfferLayout })(
      { method: "POST" } as never,
      res,
    );

    expect(readConfiguratorOfferLayout).not.toHaveBeenCalled();
    expect(res.setHeader).toHaveBeenCalledWith("Allow", "GET");
    expect(res.status).toHaveBeenCalledWith(405);
  });

  it("fails closed with 503 when the setting cannot be read", async () => {
    const res = createResponse();
    await createCommerceOfferLayoutHandler({
      readConfiguratorOfferLayout: async () => {
        throw new Error("db down");
      },
    })({ method: "GET" } as never, res);

    expect(res.status).toHaveBeenCalledWith(503);
    expect(res.setHeader).toHaveBeenCalledWith("Cache-Control", "no-store");
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({
      ok: false,
      error: expect.objectContaining({ code: "UPSTREAM_UNAVAILABLE" }),
    }));
  });

  it("refuses to publish a layout outside the contract vocabulary", async () => {
    const res = createResponse();
    await createCommerceOfferLayoutHandler({
      readConfiguratorOfferLayout: async () => "bundle_first" as never,
    })({ method: "GET" } as never, res);

    expect(res.status).toHaveBeenCalledWith(502);
  });
});

function createResponse(): VercelResponse {
  const res = {
    setHeader: vi.fn(),
    status: vi.fn(),
    json: vi.fn(),
  } as unknown as VercelResponse;
  vi.mocked(res.status).mockReturnValue(res);
  vi.mocked(res.json).mockReturnValue(res);
  return res;
}
