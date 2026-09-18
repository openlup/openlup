import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("./serviceDataGateway.js", () => ({
  readCommerceServiceDataGateway: () => null,
}));

import route from "./order-recap.js";

const originalFlag = process.env.COMMERCE_PROVIDER_PAYMENTS_ENABLED;

describe("commerce order-recap route module", () => {
  afterEach(() => {
    if (originalFlag === undefined) delete process.env.COMMERCE_PROVIDER_PAYMENTS_ENABLED;
    else process.env.COMMERCE_PROVIDER_PAYMENTS_ENABLED = originalFlag;
  });

  it("loads the observed BFF route", () => {
    expect(route).toEqual(expect.any(Function));
  });

  it("executes the disabled direct-composition refusal", async () => {
    delete process.env.COMMERCE_PROVIDER_PAYMENTS_ENABLED;
    const res = response();

    await route({ method: "GET", headers: {}, query: {} } as never, res as never);

    expect(res.status).toHaveBeenCalledWith(503);
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({
      ok: false,
      error: expect.objectContaining({ code: "UPSTREAM_UNAVAILABLE" }),
    }));
  });
});

function response() {
  const res = { setHeader: vi.fn(), status: vi.fn(), json: vi.fn() };
  res.status.mockReturnValue(res as never);
  res.json.mockReturnValue(res as never);
  return res;
}
