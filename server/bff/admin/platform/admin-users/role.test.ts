import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

describe("admin platform role BFF composition", () => {
  it("keeps the role mutation RPC behind the actor gateway and settings port", () => {
    const source = readFileSync(
      join(process.cwd(), "server/bff/admin/platform/admin-users/role.ts"),
      "utf8",
    );

    expect(source).toContain("createPlatformActorDataGateway");
    expect(source).toContain("createSupabaseAdminSettingsPort");
  });
});
