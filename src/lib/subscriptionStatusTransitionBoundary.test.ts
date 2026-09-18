import { describe, expect, it } from "vitest";

import { allMigrations, effectiveFunctionBody } from "../test/effectiveMigration";

// The LIVE body of public.subscription_guard_status_transition: the one an
// UPDATE on public.subscriptions actually fires. Until W4a this file read the
// migration that INTRODUCED the guard (20260605145000), which three later
// migrations had since fully replaced (20260610140000 provisional activation,
// 20260704160001 self-service reactivation, 20260721200000 expired-checkout
// recovery). The assertions still passed; they proved nothing about production.
const guard = effectiveFunctionBody("subscription_guard_status_transition");

// The trigger is a separate object with its own lifetime: a body replace does
// not re-create it, so it resolves to the newest migration that does.
const triggerMigrations = allMigrations().filter((migration) =>
  /CREATE TRIGGER\s+trg_subscription_guard_status_transition[\s\S]{0,200}subscription_guard_status_transition/.test(
    migration.content,
  ),
);
const trigger = triggerMigrations[triggerMigrations.length - 1];

describe("subscription status transition DB boundary", () => {
  it("fires the guard before every status update on subscriptions", () => {
    expect(trigger).toBeTruthy();
    expect(trigger?.content).toContain("BEFORE UPDATE OF status");
    expect(trigger?.content).toContain("ON public.subscriptions");
    expect(trigger?.content).toContain("EXECUTE FUNCTION public.subscription_guard_status_transition()");
  });

  it("keeps the running-lifecycle edges the subscription rail depends on", () => {
    for (const required of [
      "OLD.status = 'active' AND NEW.status IN ('paused', 'cancelled', 'completed')",
      "OLD.status = 'paused' AND NEW.status IN ('active', 'cancelled')",
      "subscription_invalid_status_transition",
    ]) {
      expect(guard).toContain(required);
    }
  });

  it("admits the provisional-activation edges", () => {
    expect(guard).toContain("OLD.status = 'pending_activation'");
    expect(guard).toContain("NEW.status IN ('active', 'activation_failed', 'cancelled')");
  });

  it("admits reactivation out of cancelled only by the owner or by audited recovery", () => {
    // Win-back: the customer reactivates their own cancelled subscription.
    expect(guard).toContain("OLD.status = 'cancelled' AND NEW.status = 'active'");
    // Expired-checkout recovery: system reopen, and only with durable proof that
    // the unpaid activation sweep is what cancelled it.
    expect(guard).toContain("NEW.status = 'pending_activation'");
    expect(guard).toContain("FROM public.subscription_events event");
    expect(guard).toContain("event.event_type = 'subscription.activation_abandoned'");
  });

  it("keeps completed and activation_failed terminal", () => {
    expect(guard).toContain("completed/activation_failed are terminal.");
    // Nothing leaves a terminal state: no edge names either as OLD.
    expect(guard).not.toMatch(/OLD\.status = 'completed'/);
    expect(guard).not.toMatch(/OLD\.status = 'activation_failed'/);
  });
});
