import type { StorefrontScenario } from "./contracts.js";

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    for (const member of Object.values(value)) deepFreeze(member);
    Object.freeze(value);
  }
  return value;
}

/**
 * The storefront proof scenarios this runner knows, frozen. Scenario ids are
 * read by stores and reports and are never renamed; a wrong scenario is
 * superseded by a new id. `runStorefrontScenario` runs one of them by id.
 *
 * - `lost_response_reload`: the response to the first place-order request is
 *   lost after the server received it; the buyer reloads and places the order
 *   again. At most one payable order, one order holding stock and one capture;
 *   progress is `awaiting_payment` offering `continue_payment`; the control
 *   blocks status reads and creates from the reload on and must keep
 *   `awaiting_payment` from being shown.
 * - `duplicate_submit`: the buyer places the order twice before the first
 *   request is answered. At most one payable order, one order holding stock,
 *   one payment attempt and one capture; no progress is judged and there is no
 *   control run, so a clean run ends `safety_only`.
 * - `lost_response_edited_payload`: as `lost_response_reload`, but the buyer
 *   changes the first name before placing the order again. Progress follows the
 *   proof file's `changedPayloadPolicy`: `update_in_place` shows
 *   `awaiting_payment` offering `continue_payment`, `refuse_changed` (also when
 *   absent or unknown) shows `details_changed` offering `continue_payment` and
 *   `start_over`. The `other_policy` control runs the steps again and must not
 *   show the other policy's progress.
 * - `reload_pending_attempt`: a payment attempt left pending is reloaded, then
 *   settled. No new payment attempt from the reload on and at most one capture;
 *   progress is `paid`; the control blocks status reads and creates from the
 *   reload on, keeps the outcomes and must keep `paid` from being shown (it may
 *   still show `awaiting_authority`). Requires the `pending` and
 *   `settled_after_pending` outcomes.
 * - `decline_retry`: a declined payment is retried and settled. At most one
 *   payable order, attempts never more than declines plus one, at most one
 *   capture; progress is `paid`; the `omit_action` control omits
 *   `retry_payment`, skips the outcomes after it and must keep `paid` from
 *   being shown. Requires the `declined` and `settled` outcomes.
 * - `paid_pending_activation`: a subscription's payment settles while its
 *   activation stays pending. Once the page shows that state (from the end of
 *   the expect step), `awaiting_payment`, `declined` and `paid` must not be
 *   shown, and at most one capture; progress
 *   is `paid_pending_activation`; the control blocks status reads and creates
 *   from the outcome on, keeps the outcomes and must keep that state from being
 *   shown. Requires the `activation_pending` outcome.
 *
 * @experimental
 */
export const storefrontScenarios: readonly StorefrontScenario[] = deepFreeze([
  {
    id: "lost_response_reload",
    title: "A lost order response and a reload keep one order",
    purchaseMode: "one_time",
    requires: { outcomes: [] },
    budget: { creates: 3 },
    text: {
      stimulus: "The server receives the first place-order request but its response never reaches the page, and the buyer reloads and places the order again with the same details.",
      safety: "The buyer ends with at most one payable order, one order holding stock and one captured payment.",
      progress: "The page shows the order awaiting payment and offers to continue to payment.",
      control: "With status reads and order creates blocked from the reload on, the page must not show the order awaiting payment.",
    },
    steps: [
      { kind: "arrange" },
      { kind: "withhold" },
      { kind: "act", action: "place_order" },
      { kind: "reload" },
      { kind: "rearrange" },
      { kind: "act", action: "place_order" },
      { kind: "expect", state: "awaiting_payment", offers: ["continue_payment"] },
    ],
    safety: { maxPayableOrders: 1, maxHolds: 1, maxCaptures: 1 },
    control: { kind: "block_read", negates: "awaiting_payment", commands: ["read", "create"], from: 3 },
  },
  {
    id: "duplicate_submit",
    title: "A double place-order click keeps one order",
    purchaseMode: "one_time",
    requires: { outcomes: [] },
    budget: { creates: 2 },
    text: {
      stimulus: "The buyer places the order twice while the first place-order request is still unanswered.",
      safety: "The buyer ends with at most one payable order, one order holding stock, one payment attempt and one captured payment.",
      progress: "No progress is judged: the scenario proves safety only.",
      control: "No control run: a safety-only scenario has no progress to negate.",
    },
    steps: [
      { kind: "arrange" },
      { kind: "act", action: "place_order", twice: true },
    ],
    safety: { maxPayableOrders: 1, maxHolds: 1, maxAttempts: 1, maxCaptures: 1 },
    control: { kind: "none", negates: null },
  },
  {
    id: "lost_response_edited_payload",
    title: "A lost order response and changed details keep one order",
    purchaseMode: "one_time",
    requires: { outcomes: [] },
    budget: { creates: 3 },
    text: {
      stimulus: "The server receives the first place-order request but its response never reaches the page, and the buyer reloads, changes the first name and places the order again.",
      safety: "The buyer ends with at most one payable order, one order holding stock and one captured payment.",
      progress: "The page handles the changed details as the declared policy says: updated in place, the order awaits payment; refused, the page shows the details changed and offers to continue or start over.",
      control: "Run again, the page must not show the progress of the other policy.",
    },
    steps: [
      { kind: "arrange" },
      { kind: "withhold" },
      { kind: "act", action: "place_order" },
      { kind: "reload" },
      { kind: "rearrange", edit: "first_name" },
      { kind: "act", action: "place_order" },
      {
        kind: "expect", state: "details_changed", offers: ["continue_payment", "start_over"],
        byPolicy: {
          update_in_place: { state: "awaiting_payment", offers: ["continue_payment"] },
          refuse_changed: { state: "details_changed", offers: ["continue_payment", "start_over"] },
        },
      },
    ],
    safety: { maxPayableOrders: 1, maxHolds: 1, maxCaptures: 1 },
    control: { kind: "other_policy", negates: null },
  },
  {
    id: "reload_pending_attempt",
    title: "A reload during a pending payment starts no second attempt",
    purchaseMode: "one_time",
    requires: { outcomes: ["pending", "settled_after_pending"] },
    budget: { creates: 1 },
    text: {
      stimulus: "The payment attempt is left pending at the payment authority, and the buyer reloads before it settles.",
      safety: "No payment attempt starts from the reload on, and the buyer ends with at most one captured payment.",
      progress: "After the reload the page still shows the payment awaiting the authority, and once it settles the page shows the order paid.",
      control: "With status reads and order creates blocked from the reload on, the page must not show the order paid.",
    },
    steps: [
      { kind: "arrange" },
      { kind: "act", action: "place_order" },
      { kind: "expect", state: "awaiting_payment", offers: [] },
      { kind: "act", action: "continue_payment" },
      { kind: "outcome", outcome: "pending" },
      { kind: "expect", state: "awaiting_authority", offers: [] },
      { kind: "reload" },
      { kind: "expect", state: "awaiting_authority", offers: [] },
      { kind: "outcome", outcome: "settled_after_pending" },
      { kind: "expect", state: "paid", offers: [] },
    ],
    // `noAttemptAfter` counts from the end of the step before the reload, so an attempt the reload's page load starts is seen.
    safety: { noAttemptAfter: 5, maxCaptures: 1 },
    control: { kind: "block_read", negates: "paid", commands: ["read", "create"], from: 6, outcomes: "kept" },
  },
  {
    id: "decline_retry",
    title: "A declined payment retried keeps one order",
    purchaseMode: "one_time",
    requires: { outcomes: ["declined", "settled"] },
    budget: { creates: 1 },
    text: {
      stimulus: "The first payment attempt is declined and the buyer retries the payment.",
      safety: "The buyer ends with at most one payable order and one captured payment, and never more payment attempts than declines plus one.",
      progress: "The page shows the decline offering a retry, and after the retry settles it shows the order paid.",
      control: "Without the retry and the outcomes after it, the page must not show the order paid.",
    },
    steps: [
      { kind: "arrange" },
      { kind: "act", action: "place_order" },
      { kind: "expect", state: "awaiting_payment", offers: [] },
      { kind: "act", action: "continue_payment" },
      { kind: "outcome", outcome: "declined" },
      { kind: "expect", state: "declined", offers: ["retry_payment"] },
      { kind: "act", action: "retry_payment" },
      { kind: "outcome", outcome: "settled" },
      { kind: "expect", state: "paid", offers: [] },
    ],
    safety: { maxPayableOrders: 1, attemptsPerDecline: true, maxCaptures: 1 },
    control: { kind: "omit_action", action: "retry_payment", negates: "paid", outcomes: "skipped" },
  },
  {
    id: "paid_pending_activation",
    title: "A settled payment with activation pending is not shown as paid",
    purchaseMode: "subscription",
    requires: { outcomes: ["activation_pending"] },
    budget: { creates: 1 },
    text: {
      stimulus: "The subscription's payment settles while its activation stays pending.",
      safety: "Once the page shows the outcome, it shows neither the order awaiting payment, nor a decline, nor the order paid, and the buyer ends with at most one captured payment.",
      progress: "The page shows the payment settled with the activation pending.",
      control: "With status reads and order creates blocked from the outcome on, the page must not show the payment settled with the activation pending.",
    },
    steps: [
      { kind: "arrange" },
      { kind: "act", action: "place_order" },
      { kind: "expect", state: "awaiting_payment", offers: [] },
      { kind: "act", action: "continue_payment" },
      { kind: "outcome", outcome: "activation_pending" },
      { kind: "expect", state: "paid_pending_activation", offers: [] },
    ],
    // The window opens once the page shows the expected state, and not before the expect step ends, so a page that learns
    // the outcome on a later poll, or a control run that never learns it, is not judged early.
    safety: { forbiddenStates: { after: 5, states: ["awaiting_payment", "declined", "paid"] }, maxCaptures: 1 },
    control: { kind: "block_read", negates: "paid_pending_activation", commands: ["read", "create"], from: 4, outcomes: "kept" },
  },
] satisfies StorefrontScenario[]);
