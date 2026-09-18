import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

describe("inventory reservations BFF boundary", () => {
  it("reads inventory reservations through the domain gateway", () => {
    const source = readFileSync(
      join(process.cwd(), "server/bff/admin/inventory/reservations.ts"),
      "utf8",
    );

    expect(source).toContain("resolveAdminInventoryRuntimeBinding");
    expect(source).not.toContain("createManagedAdminInventoryGateway");
    expect(source).not.toContain("createServiceRoleClient");
    expect(source).not.toMatch(/\.(?:from|rpc|storage)\b/);
  });
});
