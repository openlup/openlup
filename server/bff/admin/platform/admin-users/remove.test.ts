import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

describe("admin platform remove user BFF composition", () => {
  it("keeps Supabase function calls behind the admin-user remove port", () => {
    const source = readFileSync(
      join(process.cwd(), "server/bff/admin/platform/admin-users/remove.ts"),
      "utf8",
    );

    expect(source).not.toContain("@supabase/supabase-js");
    expect(source).not.toMatch(/\bcreateClient(?:\s*<[^>]+>)?\s*\(/);
    expect(source).not.toMatch(/\.(?:from|rpc)\s*\(/);
    expect(source).not.toContain("functions.invoke");
    expect(source).toContain("createAdminAuthClient");
    expect(source).toContain("authorizePlatformAdmin");
    expect(source).toContain("../../../../adapters/supabase/adminUserActionPort.js");
    expect(source).toContain("createSupabaseAdminUserRemovePort({ accessToken })");
  });
});
