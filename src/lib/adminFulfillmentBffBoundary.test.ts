import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const adminCommerceFulfillmentRoutes = [
  "server/bff/admin/fulfillment/commerce-orders.ts",
  "server/bff/admin/fulfillment/commerce-orders/create.ts",
  "server/bff/admin/fulfillment/commerce-orders/cancel.ts",
  "server/bff/admin/fulfillment/commerce-orders/detail.ts",
  "server/bff/admin/fulfillment/commerce-orders/hand-off.ts",
  "server/bff/admin/fulfillment/commerce-orders/record-label.ts",
  "server/bff/admin/fulfillment/commerce-orders/record-provider-attempt.ts",
  "server/bff/admin/fulfillment/commerce-orders/record-tracking-event.ts",
] as const;

describe("admin fulfillment BFF DB boundary", () => {
  it("keeps commerce fulfillment routes off direct service-role DB client construction", () => {
    for (const route of adminCommerceFulfillmentRoutes) {
      const source = read(route);
      expect(source, route).not.toContain("createServiceRoleClient");
      expect(source, route).not.toContain("createSupabaseCommerceFulfillmentPort");
      expect(source, route).toContain("createSupabaseAdminCommerceFulfillmentGateway");
    }
  });

  it("keeps the fulfillment shared BFF helper free of DB-client exports", () => {
    const source = read("server/bff/admin/fulfillment/commerce-orders/shared.ts");
    expect(source).not.toContain("createServiceRoleClient");
    expect(source).not.toContain("@supabase/supabase-js");
    expect(source).not.toContain("createClient");
  });
});

function read(path: string): string {
  return readFileSync(join(process.cwd(), path), "utf8");
}
