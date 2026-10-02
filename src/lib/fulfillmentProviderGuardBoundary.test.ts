import { effectiveFunctionBody } from "../test/effectiveMigration";
import { currentTrigger } from "../test/historicalBoundarySchema";
import { describe, expect, it } from "vitest";

const migration = [
  effectiveFunctionBody("commerce_validate_fulfillment_provider_kind"),
  effectiveFunctionBody("commerce_guard_fulfillment_order_provider"),
  effectiveFunctionBody("commerce_guard_fulfillment_attempt_provider"),
  currentTrigger("trg_commerce_guard_fulfillment_order_provider"),
  currentTrigger("trg_commerce_guard_fulfillment_attempt_provider"),
].join("\n");

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
