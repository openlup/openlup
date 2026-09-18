import { describe, expect, it, vi } from "vitest";
import { getAdminPlatformMe } from "./adminMeClient";

describe("getAdminPlatformMe", () => {
  it("reads the current admin role with the bearer token", async () => {
    const fetcher = vi.fn().mockResolvedValue({
      status: 200,
      json: () =>
        Promise.resolve({
          ok: true,
          data: { isAdmin: true, role: "distributor" },
        }),
    });

    await getAdminPlatformMe("admin-token", { fetcher });

    const [path, init] = fetcher.mock.calls[0] as [string, RequestInit];
    expect(path).toBe("/api/bff/admin/platform/me");
    expect(init.method).toBe("GET");
    expect(new Headers(init.headers).get("Authorization")).toBe("Bearer admin-token");
  });
});
