import { describe, expect, it, vi } from "vitest";
import { requestAdminMagicLink } from "./adminMagicLinkClient";

describe("requestAdminMagicLink", () => {
  it("requests an admin magic link without a bearer token", async () => {
    const fetcher = vi.fn().mockResolvedValue({
      status: 200,
      json: () => Promise.resolve({ ok: true, data: { accepted: true } }),
    });

    await requestAdminMagicLink("Admin@OPENLUP.com", { fetcher });

    const [path, init] = fetcher.mock.calls[0] as [string, RequestInit];
    expect(path).toBe("/api/bff/admin/platform/magic-link");
    expect(init.method).toBe("POST");
    expect(new Headers(init.headers).get("Authorization")).toBeNull();
    expect(new Headers(init.headers).get("content-type")).toBe("application/json");
    expect(init.body).toBe(JSON.stringify({ email: "Admin@OPENLUP.com" }));
  });
});
