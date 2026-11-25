import { describe, expect, it } from "vitest";
import {
  ASYNC_CHECKOUT_STATUSES,
  ORDER_STATUSES,
  checkoutActivationStatusSchema,
  subscriptionActivationStatusSchema,
} from "../../src/commerce/index.js";
import type { SubmitOutcomeClass, SubmitOutcomeClassifier } from "../../src/storefront/index.js";
import { checkoutActivationPending, classifyCheckoutAnswer, classifyStarterAnswer } from "./outcomeClassifierExamples.js";

// The examples are ordinary classifiers: a host passes them where the entry expects one.
const classifiers: SubmitOutcomeClassifier[] = [classifyCheckoutAnswer, classifyStarterAnswer];

const NOT_ANSWERS: [string, unknown][] = [["null", null], ["a string", "paid"], ["a number", 1], ["an array", [{ status: "paid" }]], ["undefined", undefined]];

describe("the commerce example classifier", () => {
  it("classifies every asynchronous checkout status, with and without an action", () => {
    const redirect = { kind: "redirect", url: "https://example.invalid/" };
    const classify = (status: string) => ({
      bare: classifyCheckoutAnswer({ status }),
      checkoutAction: classifyCheckoutAnswer({ status, clientAction: redirect }),
      checkoutNoAction: classifyCheckoutAnswer({ status, clientAction: { kind: "none" } }),
      statusAction: classifyCheckoutAnswer({ status, nextAction: redirect }),
      statusNullAction: classifyCheckoutAnswer({ status, nextAction: null }),
    });
    const every = (value: SubmitOutcomeClass) => ({ bare: value, checkoutAction: value, checkoutNoAction: value, statusAction: value, statusNullAction: value });
    const action = { bare: "awaiting_authority", checkoutAction: "needs_client_action", checkoutNoAction: "awaiting_authority",
      statusAction: "needs_client_action", statusNullAction: "awaiting_authority" };
    // Compared as a whole: a status added to commerce fails here until it is classified.
    expect(Object.fromEntries(ASYNC_CHECKOUT_STATUSES.map(status => [status, classify(status)]))).toEqual({
      paid: every("settled"),
      requires_action: action,
      pending_provider_action: action,
      processing: every("awaiting_authority"),
      failed: every("declined"),
      expired: every("declined"),
    });
  });

  it("refuses a changed price and answers unknown for an unrecognized status or shape", () => {
    expect(classifyCheckoutAnswer({ status: "price_changed", priceChanged: true })).toBe("refused");
    expect(classifyCheckoutAnswer({ status: "status_added_later" })).toBe("unknown");
    expect(classifyCheckoutAnswer({ status: "status_added_later", clientAction: { kind: "redirect" } })).toBe("unknown");
    expect(classifyCheckoutAnswer({ orderId: "order" })).toBe("unknown");
    expect(classifyCheckoutAnswer({ status: 1 })).toBe("unknown");
    for (const [, answer] of NOT_ANSWERS) expect(classifyCheckoutAnswer(answer)).toBe("unknown");
  });

  it("keeps the class when the answer carries a field it does not read", () => {
    expect(classifyCheckoutAnswer({ status: "paid", fieldAddedLater: 1 })).toBe("settled");
    expect(classifyCheckoutAnswer({ status: "failed", fieldAddedLater: {} })).toBe("declined");
    expect(classifyCheckoutAnswer({ status: "requires_action", clientAction: { kind: "redirect", fieldAddedLater: true }, fieldAddedLater: [] }))
      .toBe("needs_client_action");
  });

  it("never closes a key: the commerce answers carry no terminal-key status", () => {
    const answers = [...ASYNC_CHECKOUT_STATUSES, "price_changed", "status_added_later", "cancelled", "closed"]
      .flatMap(status => [{ status }, { status, clientAction: { kind: "redirect" } }]);
    expect(answers.map(classifyCheckoutAnswer)).not.toContain("closed");
  });
});

describe("the activation example", () => {
  it("reads every activation state of both answers, and an unknown one as pending", () => {
    const payment = Object.fromEntries(subscriptionActivationStatusSchema.options.map(status =>
      [status, checkoutActivationPending({ status: "paid", subscriptionActivation: { status, subscriptionId: null } })]));
    const checkout = Object.fromEntries(checkoutActivationStatusSchema.options.map(status =>
      [status, checkoutActivationPending({ status: "paid", subscription: { requested: true, cadenceDays: 30, activationStatus: status } })]));
    expect(payment).toEqual({ not_applicable: false, waiting_for_mandate: true, active: false, action_required: true });
    expect(checkout).toEqual({ not_applicable: false, pending_payment_success: true, activated: false, blocked_missing_payment_method: true });
  });

  it("is not pending without activation and pending for a state it does not know", () => {
    expect(checkoutActivationPending({ status: "paid" })).toBe(false);
    expect(checkoutActivationPending({ status: "paid", subscriptionActivation: { status: "activation_state_added_later" } })).toBe(true);
    expect(checkoutActivationPending({ status: "paid", subscription: { activationStatus: "activation_state_added_later" } })).toBe(true);
    expect(checkoutActivationPending({ status: "paid", subscriptionActivation: { status: 1 } })).toBe(true);
    expect(checkoutActivationPending({ status: "paid", subscriptionActivation: { status: "active", fieldAddedLater: 1 }, fieldAddedLater: 1 })).toBe(false);
  });
});

describe("the starter example classifier", () => {
  const order = (value: Record<string, unknown>) => ({ ok: true, value: { orderRef: "order", ...value } });

  it("classifies every row of the starter table", () => {
    expect(classifyStarterAnswer(order({ status: "paid" }))).toBe("settled");
    expect(classifyStarterAnswer(order({ status: "pending_payment" }))).toBe("needs_client_action");
    expect(classifyStarterAnswer(order({ status: "pending_payment", attemptState: null }))).toBe("needs_client_action");
    expect(classifyStarterAnswer(order({ status: "pending_payment", attemptState: "refused" }))).toBe("declined");
    expect(classifyStarterAnswer(order({ status: "pending_payment", attemptState: "dispatched" }))).toBe("awaiting_authority");
    expect(classifyStarterAnswer(order({ status: "pending_payment", attemptState: "indeterminate" }))).toBe("awaiting_authority");
    expect(classifyStarterAnswer(order({ status: "cancelled" }))).toBe("closed");
    expect(classifyStarterAnswer({ ok: false, code: "starter_input_invalid" })).toBe("refused");
    expect(classifyStarterAnswer({ ok: false, code: "starter_email_invalid", field: "email" })).toBe("refused");
  });

  it("classifies only the order statuses it names, each other one as unknown", () => {
    // Compared as a whole over the commerce order statuses the starter reports.
    expect(Object.fromEntries(ORDER_STATUSES.map(status => [status, classifyStarterAnswer(order({ status }))]))).toEqual({
      draft: "unknown", pending_payment: "needs_client_action", paid: "settled", failed: "unknown", expired: "unknown",
      fulfillment_pending: "unknown", cancelled: "closed", fulfilled: "unknown", refunded: "unknown",
    });
  });

  it("does not close a key on an answer that does not say nothing can settle", () => {
    expect(classifyStarterAnswer(order({ status: "expired" }))).toBe("unknown");
    expect(classifyStarterAnswer({ ok: false, code: "starter_checkout_expired" })).toBe("unknown");
    expect(classifyStarterAnswer({ ok: false, code: "starter_checkout_not_payable" })).toBe("unknown");
  });

  it("answers unknown for every other refusal, transport failure, attempt state or shape", () => {
    for (const code of ["starter_checkout_changed", "starter_checkout_paid", "starter_checkout_request_stale", "starter_code_added_later"]) {
      expect(classifyStarterAnswer({ ok: false, code, status: 409 })).toBe("unknown");
    }
    expect(classifyStarterAnswer({ ok: false, code: "starter_dependency_unavailable", status: 503 })).toBe("unknown");
    expect(classifyStarterAnswer({ ok: false, code: "transport_failed" })).toBe("unknown");
    expect(classifyStarterAnswer({ ok: false })).toBe("unknown");
    expect(classifyStarterAnswer(order({ status: "pending_payment", attemptState: "attempt_state_added_later" }))).toBe("unknown");
    expect(classifyStarterAnswer(order({ status: "status_added_later" }))).toBe("unknown");
    expect(classifyStarterAnswer(order({}))).toBe("unknown");
    expect(classifyStarterAnswer({ ok: true, value: null })).toBe("unknown");
    expect(classifyStarterAnswer({ ok: true })).toBe("unknown");
    expect(classifyStarterAnswer({ ok: "true", value: { status: "paid" } })).toBe("unknown");
    expect(classifyStarterAnswer({ value: { status: "paid" } })).toBe("unknown");
    for (const [, answer] of NOT_ANSWERS) expect(classifyStarterAnswer(answer)).toBe("unknown");
  });

  it("keeps the class when the answer carries a field it does not read", () => {
    expect(classifyStarterAnswer({ ...order({ status: "paid", fieldAddedLater: 1 }), replayed: true, fieldAddedLater: {} })).toBe("settled");
    expect(classifyStarterAnswer({ ...order({ status: "cancelled", fieldAddedLater: 1 }), fieldAddedLater: [] })).toBe("closed");
    expect(classifyStarterAnswer({ ok: false, code: "starter_input_invalid", field: "email", fieldAddedLater: 1 })).toBe("refused");
  });
});

it("gives each example a classifier's shape", () => {
  for (const classify of classifiers) expect(classify({})).toBe("unknown");
});
