import { describe, expect, it, vi } from "vitest";

describe("public communication preferences BFF route", () => {
  it("executes the observed handler and rejects methods other than POST", async () => {
    const { default: handler } = await import("./preferences.js");
    const res = createResponse();

    await handler({ method: "GET", query: {}, headers: {} } as never, res as never);

    expect(res.status).toHaveBeenCalledWith(405);
    expect(res.setHeader).toHaveBeenCalledWith("Allow", "POST");
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
