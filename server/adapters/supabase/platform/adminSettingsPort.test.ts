import { describe, expect, it, vi } from "vitest";

import { createSupabaseAdminSettingsPort } from "./adminSettingsPort.js";

describe("createSupabaseAdminSettingsPort", () => {
  it("maps settings rows into the admin settings response", async () => {
    const order = vi.fn().mockResolvedValue({
      data: [{ id: "admin-1", email: "admin@example.com", role: "admin" }],
      error: null,
    });
    const adminUsersQuery = { eq: vi.fn(), order };
    adminUsersQuery.eq.mockReturnValue(adminUsersQuery);
    const client = {
      from: vi.fn((table: string) => {
        if (table === "settings") {
          return {
            select: vi.fn().mockResolvedValue({
              data: [{ key: "tester_cap", value: 120 }],
              error: null,
            }),
          };
        }
        return {
          select: vi.fn(() => adminUsersQuery),
        };
      }),
    };

    await expect(createSupabaseAdminSettingsPort(client as never).readSettings({})).resolves.toEqual({
      settings: { tester_cap: 120 },
      adminUsers: [{ id: "admin-1", email: "admin@example.com", role: "admin" }],
    });
    expect(adminUsersQuery.eq).toHaveBeenCalledWith("membership_state", "active");
    expect(adminUsersQuery.eq).toHaveBeenCalledWith("is_machine_actor", false);
  });

  it("upserts a setting by key", async () => {
    const upsert = vi.fn().mockResolvedValue({ error: null });
    const client = {
      from: vi.fn(() => ({ upsert })),
    };

    await expect(
      createSupabaseAdminSettingsPort(client as never).updateSetting({ key: "tester_cap", value: 100 }),
    ).resolves.toEqual({ key: "tester_cap", saved: true });
    expect(upsert).toHaveBeenCalledWith({ key: "tester_cap", value: 100 }, { onConflict: "key" });
  });

  it("maps guarded admin role RPC errors to BFF-facing codes", async () => {
    const client = {
      rpc: vi.fn().mockResolvedValue({ error: { message: "last_admin_lockout" } }),
    };

    await expect(
      createSupabaseAdminSettingsPort(client as never).updateAdminUserRole({
        userId: "admin-1",
        role: "distributor",
      }),
    ).rejects.toMatchObject({ message: "At least one admin must remain.", bffCode: "CONFLICT" });
  });

  it("maps an inactive role target to a conflict rather than an upstream failure", async () => {
    const client = {
      rpc: vi.fn().mockResolvedValue({ error: { message: "target_membership_inactive" } }),
    };

    await expect(
      createSupabaseAdminSettingsPort(client as never).updateAdminUserRole({
        userId: "admin-1",
        role: "distributor",
      }),
    ).rejects.toMatchObject({
      message: "The target no longer has active panel access.",
      bffCode: "CONFLICT",
    });
  });
});
