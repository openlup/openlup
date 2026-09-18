import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  authorizeInventoryAdminWithUser,
  createAdminAuthClient,
  inventoryMutationsEnabled,
  readBearerToken,
  readManagedAdminInventoryEnv,
} from "./shared.js";

const source = readFileSync("server/bff/admin/inventory/shared.ts", "utf8");

afterEach(() => vi.unstubAllEnvs());

describe("inventory admin shared auth", () => {
  it("exposes the central admin auth helpers under inventory names", () => {
    expect(authorizeInventoryAdminWithUser).toBeTypeOf("function");
    expect(createAdminAuthClient).toBeTypeOf("function");
    expect(readBearerToken).toBeTypeOf("function");
    expect(readManagedAdminInventoryEnv).toBeTypeOf("function");
  });

  it("does not own Supabase client construction in the BFF helper", () => {
    expect(source).not.toContain("@supabase/supabase-js");
    expect(source).not.toContain("createClient");
    expect(source).not.toContain("createServiceRoleClient");
    expect(source).not.toContain("Database");
    expect(source).toContain("readSupabaseAdminServiceEnv");
  });

  it("delegates environment, authorization and mutation policy to the shared spine", async () => {
    vi.stubEnv("COMMERCE_INVENTORY_MUTATIONS_ENABLED", "true");

    const environment = readManagedAdminInventoryEnv();
    expect(environment === null || Object.values(environment).every((value) => value.length > 0))
      .toBe(true);
    expect(inventoryMutationsEnabled()).toBe(true);
    await expect(authorizeInventoryAdminWithUser(
      {} as Parameters<typeof authorizeInventoryAdminWithUser>[0],
      null,
    )).resolves.toEqual({
      ok: false,
      code: "UNAUTHORIZED",
      message: "Admin session required",
    });
  });
});
