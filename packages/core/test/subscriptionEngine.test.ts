import { describe, expect, it } from "vitest";
import {
  addPermanentAddon,
  cancelSubscription,
  completeSubscription,
  createInitialSubscriptionCheckoutModel,
  editCutoffAt,
  findDueSubscriptions,
  isEditWindowOpen,
  pauseSubscription,
  planSubscriptionCycle,
  resumeSubscription,
  skipNextCycle,
  slideNextCycle,
  swapTemplateLine,
} from "../src/subscription/index.js";
import {
  addonVariantId,
  baseTemplate,
  firstCycleAt,
  makeSubscription,
  now,
  pricingSnapshot,
  replacementVariantId,
  secondaryVariantId,
  unwrap,
} from "./subscriptionFixtures.js";

describe("subscription engine", () => {
  it("creates an active subscription and first payment-pending cycle", () => {
    const model = unwrap(createInitialSubscriptionCheckoutModel({
      subscriptionId: "sub-example",
      clientRef: "client-example",
      template: baseTemplate,
      paymentMethodRef: "pm-example",
      paymentMethodKind: "card",
      firstCycleAt,
      now,
      pricingSnapshot,
      idempotencyKey: "initial-example",
    }));

    expect(model.subscription).toMatchObject({
      id: "sub-example",
      status: "active",
      templateVersion: 1,
      nextCycleAt: firstCycleAt,
      paymentMethodRef: "pm-example",
      timezone: "UTC",
    });
    expect(model.cycle).toMatchObject({
      subscriptionId: "sub-example",
      cycleNumber: 1,
      status: "payment_pending",
      scheduledAt: firstCycleAt,
      templateVersion: 1,
      paymentMethodRef: "pm-example",
      engineIdempotencyKey: "initial-example",
    });
    expect(model.events.map((event) => event.eventType)).toEqual([
      "subscription.created",
      "subscription.cycle_planned",
      "subscription.payment_requested",
    ]);
  });

  it("records a missing payment method as an explicit cycle failure", () => {
    const model = unwrap(createInitialSubscriptionCheckoutModel({
      subscriptionId: "sub-no-payment",
      clientRef: "client-example",
      template: baseTemplate,
      paymentMethodRef: null,
      firstCycleAt,
      now,
      pricingSnapshot,
      idempotencyKey: "missing-payment",
    }));

    expect(model.cycle).toMatchObject({ status: "payment_failed", failureReason: "missing_payment_method" });
    expect(model.events.map((event) => event.eventType)).toContain("subscription.payment_failed");
  });

  it("finds only active subscriptions due at or before now", () => {
    const due = makeSubscription({ id: "due", nextCycleAt: now });
    const future = makeSubscription({ id: "future", nextCycleAt: "2026-06-04T10:00:01.000Z" });
    const paused = makeSubscription({ id: "paused", status: "paused", nextCycleAt: now });
    expect(findDueSubscriptions([future, paused, due], now).map(({ id }) => id)).toEqual(["due"]);
  });

  it("computes the edit cutoff and closes it at the boundary", () => {
    const subscription = makeSubscription();
    expect(editCutoffAt(subscription)).toBe("2026-06-09T10:00:00.000Z");
    expect(isEditWindowOpen(subscription, "2026-06-09T09:59:59.000Z")).toBe(true);
    expect(isEditWindowOpen(subscription, "2026-06-09T10:00:00.000Z")).toBe(false);
  });

  it("mutates only the template while preserving a planned cycle snapshot", () => {
    const subscription = makeSubscription();
    const planned = unwrap(planSubscriptionCycle({
      subscription,
      cycleNumber: 2,
      now,
      pricingSnapshot,
      idempotencyKey: "snapshot-example",
    }));
    const swapped = unwrap(swapTemplateLine({
      subscription,
      fromVariantId: secondaryVariantId,
      toVariantId: replacementVariantId,
      now: "2026-06-08T09:00:00.000Z",
    }));

    expect(swapped.subscription.templateVersion).toBe(2);
    expect(swapped.subscription.template.lines.map(({ variant_id }) => variant_id)).toContain(replacementVariantId);
    expect(planned.cycle.templateSnapshot.lines.map(({ variant_id }) => variant_id)).toContain(secondaryVariantId);
    expect(planned.cycle.templateSnapshot.lines.map(({ variant_id }) => variant_id)).not.toContain(replacementVariantId);
  });

  it("rejects swaps after the edit cutoff", () => {
    expect(swapTemplateLine({
      subscription: makeSubscription(),
      fromVariantId: secondaryVariantId,
      toVariantId: replacementVariantId,
      now: "2026-06-09T10:00:00.000Z",
    })).toMatchObject({ ok: false, error: { code: "edit_window_closed" } });
  });

  it("adds a permanent add-on to the default template", () => {
    const added = unwrap(addPermanentAddon({
      subscription: makeSubscription(),
      line: { variant_id: addonVariantId, qty: 2 },
      now: "2026-06-08T09:00:00.000Z",
    }));
    expect(added.subscription.templateVersion).toBe(2);
    expect(added.subscription.template.lines.at(-1)).toMatchObject({
      variant_id: addonVariantId,
      qty: 2,
      is_addon: true,
    });
  });

  it("moves the next cycle by cadence or an explicit future date", () => {
    const skipped = unwrap(skipNextCycle({
      subscription: makeSubscription(),
      now,
      reason: "customer_request",
    }));
    const slid = unwrap(slideNextCycle({
      subscription: makeSubscription(),
      now,
      newNextCycleAt: "2026-06-18T08:00:00.000Z",
    }));

    expect(skipped.subscription.nextCycleAt).toBe("2026-06-24T10:00:00.000Z");
    expect(skipped.events.map(({ eventType }) => eventType)).toEqual([
      "subscription.cycle_skipped",
      "subscription.next_cycle_at_updated",
    ]);
    expect(slid.subscription.nextCycleAt).toBe("2026-06-18T08:00:00.000Z");
    expect(slideNextCycle({ subscription: makeSubscription(), now, newNextCycleAt: now }))
      .toMatchObject({ ok: false, error: { code: "invalid_slide_target" } });
  });

  it("supports lifecycle transitions without changing the template", () => {
    const paused = unwrap(pauseSubscription({ subscription: makeSubscription(), now, reason: "customer_request" }));
    const resumed = unwrap(resumeSubscription({ subscription: paused.subscription, now }));
    const cancelled = unwrap(cancelSubscription({ subscription: resumed.subscription, now, reason: "customer_request" }));
    const completed = unwrap(completeSubscription({ subscription: makeSubscription(), now }));

    expect([paused.subscription.status, resumed.subscription.status, cancelled.subscription.status, completed.subscription.status])
      .toEqual(["paused", "active", "cancelled", "completed"]);
    expect(cancelled.subscription.template).toEqual(baseTemplate);
  });

  it("blocks illegal transitions from terminal states", () => {
    expect(resumeSubscription({ subscription: makeSubscription({ status: "cancelled" }), now }))
      .toMatchObject({ ok: false, error: { code: "invalid_transition" } });
    expect(pauseSubscription({ subscription: makeSubscription({ status: "completed" }), now }))
      .toMatchObject({ ok: false, error: { code: "invalid_transition" } });
  });
});
