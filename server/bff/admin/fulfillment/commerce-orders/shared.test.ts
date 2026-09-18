import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  authorizeCommerceFulfillmentAdminWithUser,
  createAdminAuthClient,
  readBearerToken,
  readSupabaseAdminCommerceFulfillmentEnv,
} from "./shared.js";

const source = readFileSync("server/bff/admin/fulfillment/commerce-orders/shared.ts", "utf8");

describe("commerce fulfillment admin shared auth", () => {
  it("exposes the central admin auth helpers under commerce fulfillment names", () => {
    expect(authorizeCommerceFulfillmentAdminWithUser).toBeTypeOf("function");
    expect(createAdminAuthClient).toBeTypeOf("function");
    expect(readBearerToken).toBeTypeOf("function");
    expect(readSupabaseAdminCommerceFulfillmentEnv).toBeTypeOf("function");
  });

  it("does not own Supabase client construction in the BFF helper", () => {
    expect(source).not.toContain("@supabase/supabase-js");
    expect(source).not.toContain("createClient");
    expect(source).not.toContain("Database");
    expect(source).toContain("readSupabaseAdminServiceEnv");
  });
});
