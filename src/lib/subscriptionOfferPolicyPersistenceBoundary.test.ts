import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const migration = readFileSync(
  "supabase/migrations/20260720220901_subscription_offer_policy_version.sql",
  "utf8",
);

describe("subscription offer-policy persistence boundary", () => {
  it("freezes legacy rows and syncs only the post-migration acquisition seam", () => {
    const inheritanceFunction = migration.match(
      /CREATE OR REPLACE FUNCTION public\.subscription_cycle_inherit_offer_policy\(\)[\s\S]*?AS \$\$([\s\S]*?)\$\$;/,
    )?.[1];
    expect(inheritanceFunction).toBeDefined();
    expect(migration).toContain("DEFAULT 'commerce.offer-policy.v1'");
    expect(migration).toContain("DEFAULT 'promotion-engine.v1'");
    expect(migration).toContain("DEFAULT 'legacy_frozen'");
    expect(migration).toContain("SET DEFAULT 'pending_acquisition'");
    expect(migration).toContain("offer_policy_assignment_state = 'pending_acquisition'");
    expect(migration).toContain("offer_policy_assignment_state = 'assigned_acquisition'");
    expect(migration).toContain("NEW.subscription_id IS NOT NULL");
    expect(migration).toContain("NEW.subscription_cycle_id IS NOT NULL");
    expect(inheritanceFunction).not.toContain("subscription_cycle_id");
    expect(migration).toContain("ELSIF v_state = 'assigned_acquisition'");
    expect(migration).toContain("NEW.offer_policy_assignment_state := 'inherited'");
    expect(migration).toContain("AFTER INSERT OR UPDATE OF subscription_id, subscription_cycle_id, metadata");
  });

  it("protects subscription and cycle policy identity from direct mutation", () => {
    expect(migration).toContain("subscriptions_offer_policy_immutable");
    expect(migration).toContain("subscription_cycles_offer_policy_immutable");
    expect(migration).toContain("subscription_offer_policy_immutable");
    expect(migration).toContain("subscriptions_offer_policy_pair_check");
    expect(migration).toContain("subscription_cycles_offer_policy_pair_check");
    expect(migration).toContain("OLD.offer_policy_assignment_state = 'pending_acquisition'");
    expect(migration).toContain("NEW.offer_policy_assignment_state = 'assigned_acquisition'");
  });
});
