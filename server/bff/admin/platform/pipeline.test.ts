import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

describe("admin platform pipeline BFF composition", () => {
  it("keeps DB access behind the actor gateway and pipeline port", () => {
    const source = readFileSync(join(process.cwd(), "server/bff/admin/platform/pipeline.ts"), "utf8");

    expect(source).toContain("createPlatformActorDataGateway");
    expect(source).toContain("createSupabaseAdminPipelinePort");
  });
});
