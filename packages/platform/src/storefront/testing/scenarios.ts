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
] satisfies StorefrontScenario[]);
