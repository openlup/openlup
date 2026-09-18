import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

describe("admin fulfillment detail route boundary", () => {
  it("uses the fulfillment gateway instead of direct service-role port construction", () => {
    const source = read("server/bff/admin/fulfillment/commerce-orders/detail.ts");

    expect(source).toContain("createSupabaseAdminCommerceFulfillmentGateway");
    expect(source).toContain("gateway.readPort");
    expect(source).not.toContain("createServiceRoleClient");
    expect(source).not.toContain("createSupabaseCommerceFulfillmentPort");
  });

});

function read(path: string): string {
  return readFileSync(join(process.cwd(), path), "utf8");
}
