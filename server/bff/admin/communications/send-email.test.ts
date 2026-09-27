import { beforeEach, describe, expect, it, vi } from "vitest";
import handler from "./send-email.js";

const { resolveBundleId, createAdminAuthClient, authorizeAdminBooleanWithUser,
  createTesterProgramAdminEmailPort, resolveAdminAuthBinding,
  resolveCommunicationsControlPlaneBinding } = vi.hoisted(() => ({
  resolveBundleId: vi.fn(),
  createAdminAuthClient: vi.fn(() => ({ auth: "client" })),
  authorizeAdminBooleanWithUser: vi.fn(),
  createTesterProgramAdminEmailPort: vi.fn(),
  resolveAdminAuthBinding: vi.fn(),
  resolveCommunicationsControlPlaneBinding: vi.fn(),
}));

vi.mock("../../../domains/platform-runtime/platformKernel.js", () => ({ resolveBundleId }));
vi.mock("../../../runtime/auth/adminAuthBinding.js", () => ({ resolveAdminAuthBinding }));
vi.mock("../../../runtime/communications/controlPlaneBinding.js", () => ({ resolveCommunicationsControlPlaneBinding }));
vi.mock("../../../_lib/admin-domain/auth.js", () => ({
  authorizeAdminBooleanWithUser, createAdminAuthClient,
  readBearerToken: () => "admin-token",
  readSupabaseAdminAuthEnv: () => ({ url: "https://example.supabase.co", serviceRoleKey: "service-key" }),
}));

vi.mock("#tester-program-email-binding", () => ({ createTesterProgramAdminEmailPort }));

function response() {
  return {
    statusCode: 200,
    payload: undefined as unknown,
    setHeader: vi.fn(),
    status(code: number) { this.statusCode = code; return this; },
    json(value: unknown) { this.payload = value; return this; },
  };
}
const request = (method: string, body: Record<string, unknown> = {}) => ({ method, query: {}, headers: {}, body }) as never;

describe("communications send email admin BFF route", () => {
  beforeEach(() => {
    resolveBundleId.mockReset();
    createAdminAuthClient.mockClear();
    authorizeAdminBooleanWithUser.mockReset();
    createTesterProgramAdminEmailPort.mockReset();
    resolveAdminAuthBinding.mockReset();
    resolveCommunicationsControlPlaneBinding.mockReset();
    resolveAdminAuthBinding.mockReturnValue({ error: "operator_auth_unavailable" });
  });

  it("loads through the observed admin route wrapper", () => expect(handler).toBeTypeOf("function"));

  it("rejects non-POST requests before bundle, environment, or auth resolution", async () => {
    const res = response();
    await handler(request("GET"), res as never);
    expect(res.statusCode).toBe(405);
    expect(res.setHeader).toHaveBeenCalledWith("Allow", "POST");
    for (const port of [resolveBundleId, createAdminAuthClient, authorizeAdminBooleanWithUser])
      expect(port).not.toHaveBeenCalled();
  });

  it("fails closed through the direct composition without operator auth", async () => {
    resolveBundleId.mockReturnValue("node-postgres");
    const res = response();
    await handler(request("POST"), res as never);
    expect(res.statusCode).toBe(503);
    expect(res.payload).toMatchObject({ ok: false, error: { code: "UPSTREAM_UNAVAILABLE" } });
  });

  it("retires the managed tester-template branch after authorization and before a send port", async () => {
    resolveBundleId.mockReturnValue("vercel-supabase");
    authorizeAdminBooleanWithUser.mockResolvedValue(true);
    const res = response();
    await handler(request("POST"), res as never);
    expect(createAdminAuthClient).toHaveBeenCalledWith({ url: "https://example.supabase.co", serviceRoleKey: "service-key" }, "admin-token");
    expect(authorizeAdminBooleanWithUser).toHaveBeenCalled();
    expect(createTesterProgramAdminEmailPort).not.toHaveBeenCalled();
    expect(res.statusCode).toBe(404);
    expect(res.payload).toEqual({
      ok: false,
      error: { code: "NOT_FOUND", message: "Tester programme email is no longer available" },
      meta: { requestId: expect.stringMatching(/^[0-9a-f-]{36}$/) },
    });
  });

  it("keeps the authorized node-postgres control-plane email send live", async () => {
    resolveBundleId.mockReturnValue("node-postgres");
    const authorize = vi.fn().mockResolvedValue({ ok: true, principalId: "operator-1" });
    const authRun = vi.fn(async (_token: string | null, work: (port: unknown) => Promise<unknown>) => work({ authorize }));
    const sendEmail = vi.fn().mockResolvedValue({ message: {
      id: "send-1", channel: "email", recipientId: "recipient-1", templateSlug: "receipt",
      status: "sent", provider: "resend", providerMessageId: "provider-1", skippedReason: null,
    } });
    const controlPlaneRun = vi.fn(async (work: (port: unknown) => Promise<unknown>) => work({ sendEmail }));
    resolveAdminAuthBinding.mockReturnValue({ binding: { run: authRun } });
    resolveCommunicationsControlPlaneBinding.mockReturnValue({ binding: { run: controlPlaneRun } });
    const res = response();

    await handler(request("POST", { recipientId: "recipient-1", templateSlug: "receipt" }), res as never);
    expect(authorize).toHaveBeenCalledWith("admin-token", { allowedRoles: ["admin"] });
    expect(resolveCommunicationsControlPlaneBinding).toHaveBeenCalledWith(process.env, { operatorId: "operator-1" });
    expect(sendEmail).toHaveBeenCalledWith({ recipientId: "recipient-1", templateSlug: "receipt" });
    expect(res.statusCode).toBe(200);
    expect(res.payload).toMatchObject({ ok: true, data: { message: { id: "send-1", providerMessageId: "provider-1" } } });
  });
});
