import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  authorizeAccountingAdminWithUser,
  createAdminAuthClient,
  readBearerToken,
  readSupabaseAdminAccountingEnv,
} from "./shared.js";

const source = readFileSync("server/bff/admin/accounting/shared.ts", "utf8");

describe("accounting admin shared auth", () => {
  it("exposes the central admin auth helpers under accounting names", () => {
    expect(authorizeAccountingAdminWithUser).toBeTypeOf("function");
    expect(createAdminAuthClient).toBeTypeOf("function");
    expect(readBearerToken).toBeTypeOf("function");
    expect(readSupabaseAdminAccountingEnv).toBeTypeOf("function");
  });

  it("does not own Supabase client construction in the BFF helper", () => {
    expect(source).not.toContain("@supabase/supabase-js");
    expect(source).not.toContain("createClient");
    expect(source).not.toContain("createServiceRoleClient");
    expect(source).not.toContain("Database");
    expect(source).toContain("readSupabaseAdminServiceEnv");
  });
});
