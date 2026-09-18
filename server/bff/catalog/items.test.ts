import { beforeEach, describe, expect, it, vi } from "vitest";

import handler from "./items.js";
import type { HttpRequest, HttpResponse } from "../../_lib/types/http.js";

function response(): HttpResponse {
  const res = { status: vi.fn(), json: vi.fn(), setHeader: vi.fn() } as unknown as HttpResponse;
  vi.mocked(res.status).mockReturnValue(res);
  vi.mocked(res.json).mockReturnValue(res);
  return res;
}

describe("local reference catalog BFF", () => {
  beforeEach(() => {
    delete process.env.OSS_REFERENCE_STORE_PROFILE;
  });

  it("returns 404 while the local profile is inactive", async () => {
    const res = response();
    await handler({ method: "GET", headers: {}, query: {} } as unknown as HttpRequest, res);
    expect(res.status).toHaveBeenCalledWith(404);
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({
      ok: false,
      error: expect.objectContaining({ code: "NOT_FOUND" }),
    }));
  });
});
