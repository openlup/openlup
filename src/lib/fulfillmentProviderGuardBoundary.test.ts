import { describe, expect, it } from "vitest";
import { effectiveFunctionBody, allMigrations } from "../test/effectiveMigration";
const migration = effectiveFunctionBody("commerce_validate_fulfillment_provider_kind");
const schema = allMigrations().map(({ content }) => content).join("\n");

describe("fulfillment provider guard boundary", () => {
  it("validates capability, status, and region for fulfillment provider writes", () => {
    for (const required of [
      "commerce_validate_fulfillment_provider_kind",
      "v_provider.capability <> 'fulfillment'",
      "v_provider.status NOT IN ('active', 'experimental')",
      "enabled_for_region",
      "commerce_fulfillment_provider_region_unsupported",
    ]) {
      expect(migration).toContain(required);
    }
    expect(schema).toMatch(/CREATE TRIGGER trg_commerce_guard_fulfillment_order_provider[^;]+ON public.commerce_fulfillment_orders[^;]+EXECUTE FUNCTION public.commerce_guard_fulfillment_order_provider\(\)/);
    expect(schema).toMatch(/CREATE TRIGGER trg_commerce_guard_fulfillment_attempt_provider[^;]+ON public.commerce_fulfillment_provider_attempts[^;]+EXECUTE FUNCTION public.commerce_guard_fulfillment_attempt_provider\(\)/);
  });
});
