import { describe, expect, it, vi } from "vitest";
import {
  getAdminSettings,
  inviteAdminUser,
  removeAdminUser,
  updateAdminUserRole,
  updateAdminSetting,
} from "./adminSettingsClient";

describe("admin settings client", () => {
  it("reads settings with the admin bearer token", async () => {
    const fetcher = vi.fn().mockResolvedValue({
      status: 200,
      json: () =>
        Promise.resolve({
          ok: true,
          data: {
            settings: { tester_cap: 300, counter_display: true },
            adminUsers: [{ id: "admin-1", email: "admin@openlup.com", role: "admin" }],
          },
        }),
    });

    await getAdminSettings("admin-token", { fetcher });

    const [path, init] = fetcher.mock.calls[0] as [string, RequestInit];
    expect(path).toBe("/api/bff/admin/platform/settings");
    expect(init.method).toBe("GET");
    expect(new Headers(init.headers).get("Authorization")).toBe("Bearer admin-token");
  });

  it("updates settings with the admin bearer token", async () => {
    const fetcher = vi.fn().mockResolvedValue({
      status: 200,
      json: () => Promise.resolve({ ok: true, data: { key: "tester_cap", saved: true } }),
    });

    await updateAdminSetting("admin-token", { key: "tester_cap", value: 250 }, { fetcher });

    const [path, init] = fetcher.mock.calls[0] as [string, RequestInit];
    expect(path).toBe("/api/bff/admin/platform/settings/update");
    expect(init.method).toBe("POST");
    expect(new Headers(init.headers).get("Authorization")).toBe("Bearer admin-token");
    expect(init.body).toBe(JSON.stringify({ key: "tester_cap", value: 250 }));
  });

  it("updates admin user roles with the admin bearer token", async () => {
    const fetcher = vi.fn().mockResolvedValue({
      status: 200,
      json: () =>
        Promise.resolve({
          ok: true,
          data: { userId: "admin-2", role: "admin", saved: true },
        }),
    });

    await updateAdminUserRole(
      "admin-token",
      { userId: "admin-2", role: "admin" },
      { fetcher },
    );

    const [path, init] = fetcher.mock.calls[0] as [string, RequestInit];
    expect(path).toBe("/api/bff/admin/platform/admin-users/role");
    expect(init.method).toBe("POST");
    expect(new Headers(init.headers).get("Authorization")).toBe("Bearer admin-token");
    expect(init.body).toBe(JSON.stringify({ userId: "admin-2", role: "admin" }));
  });

  it("invites admin users with the admin bearer token", async () => {
    const fetcher = vi.fn().mockResolvedValue({
      status: 200,
      json: () =>
        Promise.resolve({
          ok: true,
          data: { message: "Zaproszenie wysłane" },
        }),
    });

    await inviteAdminUser(
      "admin-token",
      { email: "new@openlup.com", role: "admin" },
      { fetcher },
    );

    const [path, init] = fetcher.mock.calls[0] as [string, RequestInit];
    expect(path).toBe("/api/bff/admin/platform/admin-users/invite");
    expect(init.method).toBe("POST");
    expect(new Headers(init.headers).get("Authorization")).toBe("Bearer admin-token");
    expect(init.body).toBe(JSON.stringify({ email: "new@openlup.com", role: "admin" }));
  });

  it("removes admin users with the admin bearer token", async () => {
    const fetcher = vi.fn().mockResolvedValue({
      status: 200,
      json: () =>
        Promise.resolve({
          ok: true,
          data: { revoked: true },
        }),
    });

    await removeAdminUser("admin-token", { userId: "admin-2" }, { fetcher });

    const [path, init] = fetcher.mock.calls[0] as [string, RequestInit];
    expect(path).toBe("/api/bff/admin/platform/admin-users/remove");
    expect(init.method).toBe("POST");
    expect(new Headers(init.headers).get("Authorization")).toBe("Bearer admin-token");
    expect(init.body).toBe(JSON.stringify({ userId: "admin-2" }));
  });
});
