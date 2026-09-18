import { describe, expect, it } from "vitest";

import type { CustomerAccountV2Response } from "@/domains/customers/accountV2Contracts";
import { subscriptionSlotState } from "./subscriptionSlotState";

type Account = Pick<CustomerAccountV2Response, "actionRequired" | "subscriptions">;
type Subscription = CustomerAccountV2Response["subscriptions"][number];
type ActionRequired = NonNullable<CustomerAccountV2Response["actionRequired"]>[number];

function sub(overrides: Partial<Subscription> = {}): Subscription {
  return {
    subscriptionId: "sub-1",
    petId: "subject-1",
    status: "active",
    cadenceDays: 21,
    paymentMethodStatus: "usable",
    ...overrides,
  } as unknown as Subscription;
}

function action(overrides: Partial<ActionRequired> = {}): ActionRequired {
  return {
    actionId: "a-1",
    kind: "payment_recovery",
    severity: "critical",
    entityType: "subscription",
    entityId: null,
    subscriptionId: "sub-1",
    orderId: null,
    messageCode: "payment_blocked",
    blockedReason: null,
    title: "t",
    body: null,
    cta: "repair_payment",
    failureCause: "unknown",
    recoveryEligible: true,
    dueAt: null,
    nextRetryAt: null,
    ...overrides,
  } as unknown as ActionRequired;
}

function account(subscriptions: Subscription[], actionRequired: ActionRequired[] = []): Account {
  return { subscriptions, actionRequired } as unknown as Account;
}

describe("subscriptionSlotState", () => {
  it("reports a free slot when nothing occupies it", () => {
    const state = subscriptionSlotState(account([]), "subject-1");
    expect(state).toEqual({
      kind: "free",
      subscriptionId: null,
      destination: null,
      tone: null,
      cadenceDays: null,
      expiredRoute: null,
    });
  });

  it("ignores a subscription belonging to another subject", () => {
    expect(subscriptionSlotState(account([sub()]), "subject-2").kind).toBe("free");
  });

  it("reads a live plan as running and carries its rhythm", () => {
    const state = subscriptionSlotState(account([sub()]), "subject-1");
    expect(state.kind).toBe("running");
    expect(state.destination).toBe("subscription");
    expect(state.tone).toBe("active");
    expect(state.cadenceDays).toBe(21);
  });

  it("separates a customer-chosen pause from a running plan", () => {
    const state = subscriptionSlotState(account([sub({ status: "paused" })]), "subject-1");
    expect(state.kind).toBe("paused_by_customer");
    expect(state.destination).toBe("subscription");
    expect(state.tone).toBe("paused");
  });

  it("sends an unpaid first charge to the repair funnel, never to management", () => {
    const state = subscriptionSlotState(
      account([sub({ status: "pending_activation" })]),
      "subject-1",
    );
    expect(state.kind).toBe("activation_unpaid");
    expect(state.destination).toBe("repair");
    expect(state.tone).toBe("pending");
  });

  // ⛔ The precedence that the whole selector exists for: a recovery case, open
  // or expired, outranks `paused`. Read the status alone and a customer who never
  // chose the pause is offered a resume the server refuses.
  it("lets an OPEN case outrank both active and paused", () => {
    for (const status of ["active", "paused"] as const) {
      const state = subscriptionSlotState(
        account([sub({ status })], [action({ messageCode: "payment_blocked" })]),
        "subject-1",
      );
      expect(state.kind).toBe("payment_open_case");
      expect(state.destination).toBe("repair");
      expect(state.tone).toBe("blocked");
      expect(state.expiredRoute).toBeNull();
    }
  });

  it("lets an EXPIRED case outrank paused and resolves its route", () => {
    const state = subscriptionSlotState(
      account(
        [sub({ status: "paused", paymentMethodStatus: "usable" })],
        [action({ messageCode: "payment_expired" })],
      ),
      "subject-1",
    );
    expect(state.kind).toBe("payment_expired_case");
    expect(state.destination).toBe("repair");
    expect(state.expiredRoute).toBe("resume");
  });

  it("asks for a method when the expired case has nothing chargeable", () => {
    const state = subscriptionSlotState(
      account(
        [sub({ status: "paused", paymentMethodStatus: "missing" })],
        [action({ messageCode: "payment_expired" })],
      ),
      "subject-1",
    );
    expect(state.kind).toBe("payment_expired_case");
    expect(state.expiredRoute).toBe("add_method");
  });

  it("does not let another subscription's case leak onto this subject", () => {
    const state = subscriptionSlotState(
      account([sub({ status: "paused" })], [action({ subscriptionId: "sub-other" })]),
      "subject-1",
    );
    expect(state.kind).toBe("paused_by_customer");
  });

  it("never leaves an occupied slot without a destination", () => {
    const occupied = [
      sub(),
      sub({ status: "paused" }),
      sub({ status: "pending_activation" }),
    ];
    for (const subscription of occupied) {
      const state = subscriptionSlotState(account([subscription]), "subject-1");
      expect(state.kind).not.toBe("free");
      expect(state.destination).not.toBeNull();
      expect(state.tone).not.toBeNull();
      expect(state.subscriptionId).toBe("sub-1");
    }
  });
});
