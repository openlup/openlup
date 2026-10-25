import { expect, it, vi } from "vitest";
import { createSubscriptionCommandExamples, createSubscriptionLifecycleMessages, createSubscriptionServices, NATIVE_SUBSCRIPTION_CAPABILITIES, subscriptionLifecycleTemplate } from "../../src/subscriptions/index.js";
import { createSubscriptionContribution } from "../../src/composition/index.js";
import type { SubscriptionCommandContext, SubscriptionLifecycleFact } from "../../src/subscriptions/contracts/index.js";

it.each([
  ["subscription.created", "subscription-welcome"], ["subscription.activation_action_required", "subscription-activation-action-required"],
  ["subscription.cancelled", "subscription-cancelled"], ["subscription.paused", "subscription-paused"],
  ["subscription.resumed", "subscription-resumed"], ["subscription.pause_reminder_due", "subscription-pause-reminder"],
  ["subscription.delivery_rescheduled", "subscription-delivery-rescheduled"], ["subscription.cycle_skipped", "subscription-cycle-skipped"],
  ["subscription.address_changed", "subscription-address-changed"], ["subscription.package_changed", "subscription-package-changed"],
  ["subscription.renewal_upcoming", "subscription-renewal-upcoming"],
  ["subscription_stock_wait.started", "subscription-stock-wait-started"], ["subscription_stock_wait.resumed", "subscription-stock-wait-resumed"],
  ["payment_failed", "subscription-payment-failed"], ["payment_expired", "subscription-payment-expired"],
  ["payment_recovered", "subscription-payment-recovered"], ["winback_eligible", "subscription-winback"],
  ["unknown", null], ["toString", null],
])("maps %s to the existing M04 template", (event, template) => { expect(subscriptionLifecycleTemplate(event)).toBe(template); });

it("passes truthful stock facts and their exact replay identity to M04, refusing a different key", async () => {
  const enqueue = vi.fn(async () => ({ notificationId: "m04:notice", replayed: true }));
  const messages = createSubscriptionLifecycleMessages({ enqueue });
  for (const kind of ["stock_wait_started", "stock_wait_resumed"] as const) {
    const fact: SubscriptionLifecycleFact = { kind, factId: "event", idempotencyKey: `wait:1:${kind}`, subscriptionId: "subscription",
      clientId: "client", cycleId: null, caseId: "case", orderId: null, occurredAt: "at", firstRecordedAt: "at", frozenFingerprint: "frozen" };
    const input = { fact, messageKey: fact.idempotencyKey, recipientRef: "recipient", locale: "en", recoveryUrlPath: null };
    expect(await messages.deliver(input)).toEqual({ notificationId: "m04:notice", replayed: true });
    expect(enqueue).toHaveBeenLastCalledWith({ ...input, templateSlug: `subscription-stock-wait-${kind.endsWith("started") ? "started" : "resumed"}` });
    expect(() => messages.deliver({ ...input, messageKey: "different" })).toThrow("identity_mismatch");
  }
  expect(enqueue).toHaveBeenCalledTimes(2);
});
it("neutral customer/operator examples preserve the trusted actor and key and expose refusal", async () => {
  const apply = vi.fn(async () => ({ outcome: "refused" as const, reason: "subscription_command_payment_blocked" as const }));
  const examples = createSubscriptionCommandExamples({ capabilities: NATIVE_SUBSCRIPTION_CAPABILITIES, apply });
  const context: SubscriptionCommandContext = { actor: { kind: "customer", actorId: "actor", clientId: "client" }, subscriptionId: "sub", idempotencyKey: "key-original", now: "at" };
  expect(await examples.customerSkip(context)).toMatchObject({ outcome: "refused" });
  expect(apply).toHaveBeenLastCalledWith({ ...context, action: "skip", reason: null, confirmedChargeTiming: true });
  const operator = { ...context, actor: { ...context.actor, kind: "operator" as const } };
  await examples.operatorSlide(operator, "later");
  expect(apply).toHaveBeenLastCalledWith({ ...operator, action: "slide", newNextCycleAt: "later", confirmedChargeTiming: true });
  expect(() => examples.operatorSlide(context, "later")).toThrow("operator_required");
  expect(() => examples.customerSkip(operator)).toThrow("customer_required");
});
it("selection and readiness precede the single executor and the selected job uses that callable", async () => {
  const readiness = vi.fn(async () => ({ kind: "ready" as const })), run = vi.fn(async () => "ran");
  const options = { capabilities: NATIVE_SUBSCRIPTION_CAPABILITIES, readiness, run };
  expect(await createSubscriptionServices(options).run()).toEqual({ kind: "refused", code: "disabled" });
  expect(readiness).not.toHaveBeenCalled(); expect(run).not.toHaveBeenCalled();
  const unready = createSubscriptionServices({ ...options, enabled: true, readiness: async () => ({ kind: "refused", code: "schema_unknown" }) });
  expect(await unready.run()).toMatchObject({ code: "schema_unknown" }); expect(run).not.toHaveBeenCalled();
  const services = createSubscriptionServices({ ...options, enabled: true });
  const base = { version: "0.24.0", requiredSchema: { version: "complete", migration: "host", objects: [] }, cadenceSeconds: 60 };
  expect(createSubscriptionContribution({ ...base, run: null }).contributions[0].schedules).toEqual([]);
  const selected = createSubscriptionContribution({ ...base, run: services.run });
  expect(selected.contributions[0].schedules).toHaveLength(1);
  expect(selected.triggers["@openlup/platform/subscriptions:subscriptions-renewal"]).toBe(services.run);
  expect(await selected.contributions[0].schedules[0].run()).toBe("ran"); expect(run).toHaveBeenCalledTimes(1);
});
