import { describe, expect, it, vi } from "vitest";
import type { VercelResponse as HttpResponse } from "../../_lib/types/vercel.js";

import { admitCheckoutRequest } from "./commerceCheckoutHandlerAdmission.js";

describe("checkout handler admission", () => {
  it("rejects non-POST requests before running admission checks", async () => {
    const res = createResponse();
    const checkRateLimit = vi.fn();
    const record = vi.fn();

    const result = await admitCheckoutRequest({
      req: { method: "GET", headers: {} },
      res,
      deps: {
        checkRateLimit,
        rateLimitMessage: () => "rate limited",
      },
      record,
    });

    expect(result).toEqual({ kind: "responded", outcome: "rejected" });
    expect(res.setHeader).toHaveBeenCalledWith("Allow", "POST");
    expect(res.status).toHaveBeenCalledWith(405);
    expect(checkRateLimit).not.toHaveBeenCalled();
    expect(record).not.toHaveBeenCalled();
  });
});

function createResponse(): HttpResponse {
  const res = {
    setHeader: vi.fn(),
    status: vi.fn(),
    json: vi.fn(),
  } as unknown as HttpResponse;
  vi.mocked(res.status).mockReturnValue(res);
  vi.mocked(res.json).mockReturnValue(res);
  return res;
}
