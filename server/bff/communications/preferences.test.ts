import { describe, expect, it, vi } from "vitest";

describe("public communication preferences BFF route", () => {
  it("public default refuses before reading a preference token", async () => {
    const { default: handler } = await import("./preferences.js");
    const res = createResponse();

    const touched = vi.fn(() => { throw new Error("token read"); });
    const req = { method: "POST", query: {}, headers: {} };
    Object.defineProperty(req, "body", { get: touched });
    await handler(req as never, res as never);
    expect(touched).not.toHaveBeenCalled();

    expect(res.status).toHaveBeenCalledWith(503);
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ error: expect.objectContaining({ details: expect.objectContaining({ reason: "adopter_policy_required" }) }) }));
  });
});

function createResponse() {
  const res = {
    setHeader: vi.fn(),
    status: vi.fn(),
    json: vi.fn(),
    end: vi.fn(),
  };
  res.status.mockReturnValue(res);
  res.json.mockReturnValue(res);
  res.end.mockReturnValue(res);
  return res;
}
