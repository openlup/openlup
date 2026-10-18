import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it, vi } from "vitest";

describe("admin platform me BFF composition", () => {
  it("keeps DB access behind the actor gateway and platform port", () => {
    const source = readFileSync(join(process.cwd(), "server/bff/admin/platform/me.ts"), "utf8");

    expect(source).toContain("createPlatformActorDataGateway");
    expect(source).toContain("createSupabaseAdminPlatformPort");
  });
});


vi.mock("../../../_lib/observability/route.js", () => ({ withObservedRoute: (_options: unknown, handler: unknown) => handler }));
vi.mock("../../../_lib/admin-domain/auth.js", () => ({ createServiceRoleClient: vi.fn(), readSupabaseAdminServiceEnv: () => ({ url: "https://example.invalid", serviceRoleKey: "synthetic-service" }) }));
vi.mock("./shared.js", () => ({ readBearerToken: () => "synthetic-token", createPlatformActorDataGateway: () => ({ asActor: async (_actor: unknown, run: (client: unknown) => unknown) => run({}) }) }));
vi.mock("../../../adapters/supabase/platform/adminPlatformPort.js", () => ({
  authenticateSupabasePlatformUser: async () => ({ ok: true, userId: "d4400000-0000-4000-8000-000000000001" }),
  createSupabaseAdminPlatformPort: vi.fn(),
}));
it.each([
  { isAdmin: true, role: "admin" as const },
  { isAdmin: false, role: null },
])("reference me reads membership without service activation on repeated requests: %j", async (membership) => {
  const { createServiceRoleClient } = await import("../../../_lib/admin-domain/auth.js");
  const { createSupabaseAdminPlatformPort } = await import("../../../adapters/supabase/platform/adminPlatformPort.js");
  const { default: handler } = await import("./me.js");
  const id = "d4400000-0000-4000-8000-000000000001";
  const getAdminMe = vi.fn(async () => membership);
  vi.mocked(createServiceRoleClient).mockClear();
  vi.mocked(createSupabaseAdminPlatformPort).mockReturnValue({ getAdminMe } as never);
  for (let retry = 0; retry < 2; retry++) {
    const response = { status: vi.fn().mockReturnThis(), json: vi.fn().mockReturnThis(), setHeader: vi.fn(), getHeader: vi.fn() };
    await handler({ method: "GET", query: {}, headers: {} } as never, response as never);
    expect(response.status).toHaveBeenCalledWith(200);
    expect(response.json).toHaveBeenCalledWith(expect.objectContaining({ ok: true, data: membership }));
  }
  expect(getAdminMe).toHaveBeenCalledTimes(2);
  expect(getAdminMe).toHaveBeenNthCalledWith(1, id);
  expect(getAdminMe).toHaveBeenNthCalledWith(2, id);
  expect(createServiceRoleClient).not.toHaveBeenCalled();
});
