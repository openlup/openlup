import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import { allMigrations, effectiveFunctionBody } from "../test/effectiveMigration.js";
import { managedTable } from "../test/managedSchema.js";

const shippedSql = allMigrations().map(({ content }) => content).join("\n");
function trigger(name: string): string {
  const registrations = [...shippedSql.matchAll(new RegExp(`^CREATE TRIGGER ${name}\\b[^;]*;`, "gm"))];
  expect(registrations, `${name} registration`).toHaveLength(1);
  return registrations[0]![0];
}

describe("subscription offer-policy persistence boundary", () => {
  it("freezes legacy rows and syncs only the post-migration acquisition seam", () => {
    const migration = readFileSync("supabase/migrations/20260720220901_subscription_offer_policy_version.sql", "utf8");
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

  it("keeps the shipped acquisition-only synchronization and inherited cycle policy", () => {
    const inheritance = effectiveFunctionBody("subscription_cycle_inherit_offer_policy");
    const sync = effectiveFunctionBody("subscription_sync_offer_policy_from_order");
    expect(managedTable("subscriptions")).toContain("offer_policy_assignment_state text DEFAULT 'pending_acquisition'::text NOT NULL");
    expect(managedTable("subscription_cycles")).toContain("offer_policy_assignment_state text DEFAULT 'legacy_frozen'::text NOT NULL");
    expect(sync).toContain("offer_policy_assignment_state = 'pending_acquisition'");
    expect(sync).toContain("offer_policy_assignment_state = 'assigned_acquisition'");
    expect(sync).toContain("NEW.subscription_id IS NOT NULL");
    expect(sync).toContain("NEW.subscription_cycle_id IS NOT NULL");
    expect(inheritance).not.toContain("subscription_cycle_id");
    expect(inheritance).toContain("ELSIF v_state = 'assigned_acquisition'");
    expect(inheritance).toContain("NEW.offer_policy_assignment_state := 'inherited'");
    expect(trigger("commerce_orders_sync_subscription_offer_policy")).toContain(
      "AFTER INSERT OR UPDATE OF subscription_id, subscription_cycle_id, metadata ON public.commerce_orders FOR EACH ROW EXECUTE FUNCTION public.subscription_sync_offer_policy_from_order()",
    );
    expect(trigger("subscription_cycles_inherit_offer_policy")).toContain(
      "BEFORE INSERT ON public.subscription_cycles FOR EACH ROW EXECUTE FUNCTION public.subscription_cycle_inherit_offer_policy()",
    );
  });

  it("protects subscription and cycle policy identity from direct mutation", () => {
    const immutable = effectiveFunctionBody("subscription_prevent_offer_policy_update");
    expect(immutable).toContain("subscription_offer_policy_immutable");
    expect(immutable).toContain("OLD.offer_policy_assignment_state = 'pending_acquisition'");
    expect(immutable).toContain("NEW.offer_policy_assignment_state = 'assigned_acquisition'");
    expect(immutable).toContain("pg_trigger_depth() > 1");
    for (const table of ["subscriptions", "subscription_cycles"]) {
      expect(managedTable(table)).toContain(`ADD CONSTRAINT ${table}_offer_policy_pair_check`);
      expect(trigger(`${table}_offer_policy_immutable`)).toContain(
        `BEFORE UPDATE OF offer_policy_version, promotion_engine_version, offer_policy_assignment_state ON public.${table} FOR EACH ROW EXECUTE FUNCTION public.subscription_prevent_offer_policy_update()`,
      );
    }
  });
});
