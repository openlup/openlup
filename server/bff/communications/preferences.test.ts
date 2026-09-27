import { describe, expect, it, vi } from "vitest";
// This suite exercises the handler behind an explicitly admitting adopter policy.
// The public composition's default refusal is covered by its own policy suite.
vi.mock("#deployment-route-policy", async (importOriginal) => ({
  ...(await importOriginal<typeof import("#deployment-route-policy")>()),
  enforceDeploymentRoutePolicy: () => true,
}));


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
