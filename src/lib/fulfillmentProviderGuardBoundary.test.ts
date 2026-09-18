import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const migration = read("supabase/migrations/20260605151000_fulfillment_provider_capability_guard.sql");

describe("fulfillment provider guard boundary", () => {
  it("validates capability, status, and region for fulfillment provider writes", () => {
    for (const required of [
      "commerce_validate_fulfillment_provider_kind",
      "v_provider.capability <> 'fulfillment'",
      "v_provider.status NOT IN ('active', 'experimental')",
      "enabled_for_region",
      "commerce_fulfillment_provider_region_unsupported",
      "trg_commerce_guard_fulfillment_order_provider",
      "trg_commerce_guard_fulfillment_attempt_provider",
    ]) {
      expect(migration).toContain(required);
    }
  });
});

function read(path: string): string {
  return readFileSync(join(process.cwd(), path), "utf8");
}
