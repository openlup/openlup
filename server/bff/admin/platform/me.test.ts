import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

describe("admin platform me BFF composition", () => {
  it("keeps DB access behind the actor gateway and platform port", () => {
    const source = readFileSync(join(process.cwd(), "server/bff/admin/platform/me.ts"), "utf8");

    expect(source).not.toContain("@supabase/supabase-js");
    expect(source).not.toMatch(/\bcreateClient(?:\s*<[^>]+>)?\s*\(/);
    expect(source).not.toMatch(/\.(?:from|rpc)\s*\(/);
    expect(source).toContain("createPlatformActorDataGateway");
    expect(source).toContain("createSupabaseAdminPlatformPort");
  });
});
