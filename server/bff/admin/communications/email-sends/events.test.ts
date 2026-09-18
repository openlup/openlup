import { beforeEach, describe, expect, it, vi } from "vitest";
import type { VercelRequest, VercelResponse } from "../../../../_lib/types/vercel.js";
import handler from "./events.js";

const mocks = vi.hoisted(() => ({
  authorizeAdminBooleanWithUser: vi.fn(),
  createAdminAuthClient: vi.fn(),
  readBearerToken: vi.fn(),
  readSupabaseAdminServiceEnv: vi.fn(),
  createSupabaseAdminCommunicationsGateway: vi.fn(),
  createCommunicationsAdminEmailSendEventsHandler: vi.fn(),
}));

vi.mock("../../../../_lib/admin-domain/auth.js", () => ({
  authorizeAdminBooleanWithUser: mocks.authorizeAdminBooleanWithUser,
  createAdminAuthClient: mocks.createAdminAuthClient,
  readBearerToken: mocks.readBearerToken,
  readSupabaseAdminServiceEnv: mocks.readSupabaseAdminServiceEnv,
}));

vi.mock("../../../../adapters/supabase/communicationsGateway.js", () => ({
  createSupabaseAdminCommunicationsGateway: mocks.createSupabaseAdminCommunicationsGateway,
}));

vi.mock("../../../../domains/communications/adminEmailSendsHandler.js", () => ({
  createCommunicationsAdminEmailSendEventsHandler: mocks.createCommunicationsAdminEmailSendEventsHandler,
}));

vi.mock("../../../../_lib/observability/route.js", () => ({
  withObservedRoute: (_options: unknown, routeHandler: typeof handler) => routeHandler,
}));

describe("communications email send events admin BFF route", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("loads through the observed admin route wrapper", () => {
    expect(handler).toBeTypeOf("function");
  });

  it("authorizes with the user-scoped client but reads event detail through the communications gateway", async () => {
    const env = { url: "https://staging.supabase.co", anonKey: "anon", serviceRoleKey: "service" };
    const authClient = { kind: "auth-client" };
    const readPort = { kind: "read-port" };
    mocks.readSupabaseAdminServiceEnv.mockReturnValue(env);
    mocks.readBearerToken.mockReturnValue("admin-token");
    mocks.createAdminAuthClient.mockReturnValue(authClient);
    mocks.createSupabaseAdminCommunicationsGateway.mockReturnValue({
      emailSendsReadPort: () => readPort,
    });
    mocks.authorizeAdminBooleanWithUser.mockResolvedValue(true);
    mocks.createCommunicationsAdminEmailSendEventsHandler.mockImplementation((deps) => async (
      req: VercelRequest,
      res: VercelResponse,
    ) => {
      expect(deps.readPort).toBe(readPort);
      const authorized = await deps.authorizeAdmin(req);
      res.status(200).json({ ok: true, data: { authorized } });
    });

    const res = createResponse();
    await handler(request(), res);

    expect(mocks.createAdminAuthClient).toHaveBeenCalledWith(env, "admin-token");
    expect(mocks.createSupabaseAdminCommunicationsGateway).toHaveBeenCalledWith(env);
    expect(mocks.authorizeAdminBooleanWithUser).toHaveBeenCalledWith(
      authClient,
      "admin-token",
      { allowedRoles: ["admin"] },
    );
    expect(res.status).toHaveBeenCalledWith(200);
  });
});

function request(): VercelRequest {
  return { method: "GET", query: {}, headers: { authorization: "Bearer admin-token" } } as unknown as VercelRequest;
}

function createResponse(): VercelResponse {
  const res = { setHeader: vi.fn(), status: vi.fn(), json: vi.fn() } as unknown as VercelResponse;
  vi.mocked(res.status).mockReturnValue(res);
  vi.mocked(res.json).mockReturnValue(res);
  return res;
}
