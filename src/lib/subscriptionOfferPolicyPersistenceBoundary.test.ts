import { effectiveFunctionBody } from "../test/effectiveMigration";
import { currentTableStatements, currentTrigger } from "../test/historicalBoundarySchema";
import { describe, expect, it } from "vitest";

const migration = [currentTableStatements("subscriptions"), currentTableStatements("subscription_cycles"), effectiveFunctionBody("subscription_cycle_inherit_offer_policy"), effectiveFunctionBody("subscription_prevent_offer_policy_update"), effectiveFunctionBody("subscription_sync_offer_policy_from_order"), currentTrigger("subscriptions_offer_policy_immutable"), currentTrigger("subscription_cycles_offer_policy_immutable"), currentTrigger("commerce_orders_sync_subscription_offer_policy")].join("\n");

describe("subscription offer-policy persistence boundary", () => {
  it("freezes legacy rows and syncs only the post-migration acquisition seam", () => {
    const inheritanceFunction = effectiveFunctionBody("subscription_cycle_inherit_offer_policy");
    expect(inheritanceFunction).toBeDefined();
    expect(migration).toContain("DEFAULT 'commerce.offer-policy.v1'");
    expect(migration).toContain("DEFAULT 'promotion-engine.v1'");
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
