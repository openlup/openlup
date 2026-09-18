import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

describe("admin platform role BFF composition", () => {
  it("keeps the role mutation RPC behind the actor gateway and settings port", () => {
    const source = readFileSync(
      join(process.cwd(), "server/bff/admin/platform/admin-users/role.ts"),
      "utf8",
    );

    expect(source).not.toContain("@supabase/supabase-js");
    expect(source).not.toMatch(/\bcreateClient(?:\s*<[^>]+>)?\s*\(/);
    expect(source).not.toMatch(/\.(?:from|rpc)\s*\(/);
    expect(source).toContain("createPlatformActorDataGateway");
    expect(source).toContain("createSupabaseAdminSettingsPort");
  });
});
