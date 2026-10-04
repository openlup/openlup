import { afterEach, describe, expect, it, vi } from "vitest";
import handler, { routes } from "./[...path].js";
import { dispatch } from "../../server/runtime/bffDispatch.js";
const preflight = vi.hoisted(() => vi.fn(async () => true));
vi.mock("../../server/runtime/auth/adminAuthBinding.js", () => ({ preflightAdminBffRoute: preflight }));

afterEach(() => { vi.unstubAllEnvs(); preflight.mockClear(); });
function response() {
  const res = { status: vi.fn(), json: vi.fn(), setHeader: vi.fn() };
  res.status.mockReturnValue(res);
  return res;
}
describe("bounded public BFF route composition", () => {
  it("exposes no BFF routes and returns404 for an unknown request", async () => {
    expect(routes).toEqual([]);
    const res = response();
    await handler({ method: "GET", url: "/api/bff/example", headers: {}, query: {} } as never, res as never);
    expect(res.status).toHaveBeenCalledWith(404);
    expect(preflight).not.toHaveBeenCalled();
  });
  it("refuses an explicitly composed direct-only entry before auth or handler on a managed bundle", async () => {
    vi.stubEnv("PLATFORM_BUNDLE", "vercel-supabase");
    const work = vi.fn();
    const res = response();
    await dispatch([{ route: "/api/bff/example", pattern: /^\/api\/bff\/example$/, params: [], handler: work, availability: "direct-postgres" }],
      { method: "GET", url: "/api/bff/example", headers: {}, query: {} } as never, res as never);
    expect(res.status).toHaveBeenCalledWith(404);
    expect(preflight).not.toHaveBeenCalled();
    expect(work).not.toHaveBeenCalled();
  });
  it("dispatches the same explicit entry under the supported direct bundle", async () => {
    vi.stubEnv("PLATFORM_BUNDLE", "node-postgres");
    const work = vi.fn();
    const req = { method: "GET", url: "/api/bff/example", headers: {}, query: {} };
    const res = response();
    await dispatch([{ route: "/api/bff/example", pattern: /^\/api\/bff\/example$/, params: [], handler: work, availability: "direct-postgres" }], req as never, res as never);
    expect(preflight).toHaveBeenCalledWith(req, res, "/api/bff/example");
    expect(work).toHaveBeenCalledWith(req, res);
  });
});
