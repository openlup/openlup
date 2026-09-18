import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  authorizePlatformAdmin: vi.fn(),
  createAdminAuthClient: vi.fn(),
  readBearerToken: vi.fn(),
  readEnv: vi.fn(),
  sendBffError: vi.fn(),
}));
vi.mock("../../../../_lib/observability/route.js", () => ({ withObservedRoute: (_meta: unknown, route: unknown) => route }));
vi.mock("../../../../_lib/bff/response.js", () => ({ sendBffError: mocks.sendBffError }));
vi.mock("../../../../_lib/admin-domain/auth.js", () => ({ createAdminAuthClient: mocks.createAdminAuthClient }));
vi.mock("../shared.js", () => ({
  authorizePlatformAdmin: mocks.authorizePlatformAdmin,
  readBearerToken: mocks.readBearerToken,
  readSupabaseEnv: mocks.readEnv,
}));

import handler from "./dhl-tracking-refresh.js";

describe("admin pipeline direct-DHL tracking route", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.readEnv.mockReturnValue({ url: "https://example.invalid", anonKey: "anon" });
    mocks.readBearerToken.mockReturnValue("admin-token");
    mocks.createAdminAuthClient.mockReturnValue({ auth: {} });
    mocks.authorizePlatformAdmin.mockResolvedValue({ ok: true });
  });

  it("returns a deterministic retirement response without constructing a provider", async () => {
    const response = {} as Parameters<typeof handler>[1];
    await handler({ headers: {} } as Parameters<typeof handler>[0], response);

    expect(mocks.sendBffError).toHaveBeenCalledWith(
      response,
      "NOT_FOUND",
      "Standalone DHL tracking is retired",
      { details: { reason: "direct_dhl_tracking_retired" } },
    );
    expect(mocks.authorizePlatformAdmin).toHaveBeenCalledWith({ auth: {} }, "admin-token");
  });

  it("does not disclose retirement before admin authorization", async () => {
    mocks.authorizePlatformAdmin.mockResolvedValue({ ok: false, code: "FORBIDDEN", message: "Admin role required" });
    const response = {} as Parameters<typeof handler>[1];
    await handler({ headers: {} } as Parameters<typeof handler>[0], response);

    expect(mocks.sendBffError).toHaveBeenCalledWith(response, "FORBIDDEN", "Admin role required");
    expect(mocks.sendBffError).not.toHaveBeenCalledWith(
      response,
      "NOT_FOUND",
      expect.anything(),
      expect.anything(),
    );
  });
});
