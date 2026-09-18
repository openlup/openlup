import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ readGateway: vi.fn() }));
vi.mock("./serviceDataGateway.js", () => ({
  readCommerceServiceDataGateway: mocks.readGateway,
}));

import handler from "./checkouts.js";
import type { HttpRequest, HttpResponse } from "../../_lib/types/http.js";

function response(): HttpResponse {
  const res = { status: vi.fn(), json: vi.fn(), setHeader: vi.fn() } as unknown as HttpResponse;
  vi.mocked(res.status).mockReturnValue(res);
  vi.mocked(res.json).mockReturnValue(res);
  return res;
}

describe("local reference checkout BFF composition", () => {
  const originalProfile = process.env.OSS_REFERENCE_STORE_PROFILE;

  beforeEach(() => {
    mocks.readGateway.mockReset();
    delete process.env.OSS_REFERENCE_STORE_PROFILE;
  });

  it("returns 404 before reading the service gateway when the local profile is inactive", async () => {
    const res = response();
    await handler({ method: "POST", body: {}, headers: {}, query: {} } as unknown as HttpRequest, res);

    expect(res.status).toHaveBeenCalledWith(404);
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({
      ok: false,
      error: expect.objectContaining({ code: "NOT_FOUND" }),
    }));
    expect(mocks.readGateway).not.toHaveBeenCalled();
  });

  // Keep the parent process clean for test files that follow in the shared
  // Vitest worker, even when this module is run alone.
  afterAll(() => {
    if (originalProfile === undefined) delete process.env.OSS_REFERENCE_STORE_PROFILE;
    else process.env.OSS_REFERENCE_STORE_PROFILE = originalProfile;
  });
});
