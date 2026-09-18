import { describe, expect, it, vi } from "vitest";
import type { HttpRequest, HttpResponse } from "../../../_lib/types/http.js";

vi.mock("../../../_lib/admin-domain/auth.js", () => ({
  readSupabaseAdminAuthEnv: () => null,
  readBearerToken: vi.fn(),
  createAdminAuthClient: vi.fn(),
  authorizeAdminBooleanWithUser: vi.fn(),
}));
import handler from "./survey-responses.js";

describe("legacy marketing-tools survey responses admin BFF route", () => {
  it("executes the managed fail-closed path through the observed wrapper", async () => {
    const res = response();
    await handler({ method: "GET", headers: {}, query: {} } as unknown as HttpRequest, res);
    expect(res.status).toHaveBeenCalledWith(500);
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({
      ok: false,
      error: expect.objectContaining({ code: "INTERNAL" }),
    }));
  });
});

function response(): HttpResponse {
  const res = { statusCode: 200, setHeader: vi.fn(), status: vi.fn(), json: vi.fn() } as unknown as HttpResponse;
  vi.mocked(res.status).mockReturnValue(res);
  vi.mocked(res.json).mockReturnValue(res);
  return res;
}
