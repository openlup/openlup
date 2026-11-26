// Internal: the one table of finding texts, keyed by code and cause. No public
// declaration imports this module, so it stays out of the API report. A code with
// several causes gives the cause and fix of the cause observed.

/**
 * Facts of one observation. `at` names the step ("Step 5 (act place_order) of
 * the clean run"); the others are counts, anchor names, matcher fields and paths
 * without query. No fact carries a body, a token or a command key value.
 */
export type FindingFacts = {
  readonly at: string;
  readonly count?: number;
  readonly limit?: number;
  readonly name?: string;
  readonly seen?: string;
  readonly detail?: string;
};

type FindingText = { readonly observed: (facts: FindingFacts) => string; readonly cause: string | ((facts: FindingFacts) => string); readonly fix: string };

const seen = (facts: FindingFacts) => facts.seen === undefined || facts.seen === "" ? "no state or action anchor" : facts.seen;

const texts: Readonly<Record<string, Readonly<Record<string, FindingText>>>> = {
  duplicate_order: {
    only: {
      observed: (f) => `${f.at}: the run's buyer has ${f.count} payable orders; the scenario allows ${f.limit}.`,
      cause: "The page created another payable order for the same purchase instead of reusing the first one.",
      fix: "Send every repeat of one purchase under the command key of its first create, keep that key across a reload, and let the server replay its first answer.",
    },
  },
  duplicate_hold: {
    only: {
      observed: (f) => `${f.at}: ${f.count} of the buyer's orders hold stock; the scenario allows ${f.limit}.`,
      cause: "Another order reserved stock for the same purchase.",
      fix: "Make a repeated create replay the first order instead of reserving stock for a new one.",
    },
  },
  duplicate_capture: {
    only: {
      observed: (f) => `${f.at}: the buyer has ${f.count} captured payments; the scenario allows ${f.limit}.`,
      cause: "The payment was taken more than once.",
      fix: "Capture each order once: reuse the first payment attempt's answer for a repeated request.",
    },
  },
  second_attempt: {
    only: {
      observed: (f) => `${f.at}: the buyer has ${f.count} payment attempts; the scenario allows ${f.limit}.`,
      cause: "The page started a payment attempt the scenario forbids.",
      fix: "Start one payment attempt per buyer action and reuse it while it is unresolved.",
    },
  },
  forbidden_state_shown: {
    paid_without_capture: {
      observed: (f) => `${f.at}: the page shows ${f.name} while the ledger has ${f.detail}.`,
      cause: "The page claims a paid state the ledger does not hold: a paid state needs at least one capture and no payable order.",
      fix: "Show a paid state only from a status read that reports the capture.",
    },
    after_step: {
      observed: (f) => `${f.at}: the page shows ${f.name}, which the scenario forbids from the end of ${f.detail} on.`,
      cause: "After the outcome the page shows a state that contradicts it: an earlier state, a decline or a paid state the outcome rules out.",
      fix: "Show the state the server reports after the outcome, and never fall back to an earlier or contradicting state when a status read fails.",
    },
  },
  order_outside_subject: {
    only: {
      observed: (f) => `${f.at}: the database gained ${f.count} payable orders while the run's buyer gained ${f.limit}.`,
      cause: "The run created payable orders for a buyer other than the one it typed.",
      fix: "Create orders for the buyer the checkout form names, and give each proof run a database no other process writes to.",
    },
  },
  progress_not_reached: {
    only: {
      observed: (f) => `${f.at}: expected ${f.name}; the page shows ${seen(f)}.`,
      cause: "The page reached another state than the one the scenario expects.",
      fix: "Make the page reach the expected state after this buyer journey, as the scenario's progress sentence describes.",
    },
  },
  vacuous_progress: {
    blocked: {
      observed: (f) => `${f.at}: the page shows ${f.name} although the control should keep it from being reached.`,
      cause: "The page shows the state without the requests the control blocked, so the clean run's progress proves nothing about them.",
      fix: "Show the state only from the server's answer to a create or a status read, not from state kept in the page.",
    },
    omitted: {
      observed: (f) => `${f.at}: the page shows ${f.name} although the control omitted ${f.detail} and no status read was matched.`,
      cause: "The page shows the state without the omitted action and without a status read, so the clean run's progress proves nothing about the action.",
      fix: "Show the state only after the buyer's action and the server's answer, or declare the action in autoProgress and let the page read the status.",
    },
    other_policy: {
      observed: (f) => `${f.at}: the page shows ${f.name}, the progress of the policy the proof file does not declare.`,
      cause: "The control run handled the changed details under the policy the proof file does not declare, so the clean run's progress proves nothing about the declared one.",
      fix: "Apply one changed-payload policy to every purchase, and declare it as changedPayloadPolicy.",
    },
  },
  policy_mismatch: {
    only: {
      observed: (f) => `${f.at}: expected ${f.name} under the declared policy ${f.detail}; the page shows ${f.seen}, the other policy's progress.`,
      cause: "The store handles changed details under the policy the proof file does not declare (an absent or unknown changedPayloadPolicy reads as refuse_changed).",
      fix: "Declare the policy the store applies as changedPayloadPolicy in the proof file, or make the store apply the declared one.",
    },
  },
  auto_progress_undeclared: {
    only: {
      observed: (f) => `${f.at}: the page shows ${f.name} although the control omitted ${f.detail}; ${f.count} status reads were matched before it.`,
      cause: "The page performed the omitted action by itself and read the status, without the proof file or adapter declaring it.",
      fix: "Declare the action in autoProgress (proof file or adapter), so the runner leaves it to the page and blocks status reads instead.",
    },
  },
  adapter_matcher_unmatched: {
    create: {
      observed: (f) => `${f.at}: the create matcher matched no request.`,
      cause: "The create matcher names a method or path the page never requested.",
      fix: "Point commands.create at the request that creates the order: its method and its path without query.",
    },
    read: {
      observed: (f) => `${f.at}: the read matcher matched no request.`,
      cause: "The read matcher names a method or path the page never requested.",
      fix: "Point commands.read at the request that reads the purchase's status after a reload: its method and its path without query.",
    },
    blocked_set: {
      observed: (f) => `${f.at}: no ${f.detail} request matched from ${f.name} on.`,
      cause: "The control would block nothing: none of its commands was requested from the step it starts at.",
      fix: "Point commands.create and commands.read at the requests the page sends after a reload.",
    },
  },
  adapter_anchor_missing: {
    action: {
      observed: (f) => `${f.at}: the action ${f.name} did not resolve${f.detail === undefined ? "" : ` (${f.detail})`}; the page shows ${seen(f)}.`,
      cause: "No enabled element carries the action anchor, or its custom locator matches nothing.",
      fix: "Put the action anchor on the control the buyer uses, or map the action to a CSS locator in the adapter's actions.",
    },
    field: {
      observed: (f) => `${f.at}: the field ${f.name} did not resolve; the page shows ${seen(f)}.`,
      cause: "No input carries the field anchor.",
      fix: "Put the field anchor on the input, or arrange the buyer's details with an adapter arrange function.",
    },
    state: {
      observed: (f) => `${f.at}: expected ${f.name}; no state anchor is shown (the page shows ${seen(f)}).`,
      cause: "The page shows no state anchor where the scenario expects one.",
      fix: "Put the state anchor on the element that shows the purchase's state, or map the state to a CSS locator in the adapter's actions.",
    },
  },
  anchor_hidden: {
    only: {
      observed: (f) => `${f.at}: ${f.name} resolved but is not visible (${f.detail}).`,
      cause: "The anchor exists but a buyer cannot see it: it is hidden, transparent, covered or out of reach at this width.",
      fix: "Show the anchored element to the buyer at this width, or move the anchor to the element the buyer sees.",
    },
  },
  control_not_applied: {
    only: {
      observed: (f) => `${f.at}: the control blocked no request.`,
      cause: "The control took no effect, so the run cannot tell progress from state kept in the page.",
      fix: "Point commands.create and commands.read at the requests the page sends from the control's step on.",
    },
  },
  arrange_failed: {
    only: {
      observed: (f) => `${f.at}: the arrangement failed (${f.detail}).`,
      cause: "The store's steps up to the first buyer action did not complete.",
      fix: "Declare routes.selectionEntry for the scenario's purchase mode in the proof file, or give the adapter an arrange function that completes.",
    },
  },
  observer_subject_unseen: {
    order_before_arrange: {
      observed: (f) => `${f.at}: the run's buyer already had ${f.count} orders before the arrangement.`,
      cause: "The subject is not fresh, so the ledger cannot be attributed to this run.",
      fix: "Use a new runId for every run, or give the run a database no earlier run wrote to.",
    },
    no_order_after_create: {
      observed: (f) => `${f.at}: ${f.count} create requests matched, but the observer shows no order for the run's buyer.`,
      cause: "The observer does not see the orders this run created: the page typed another buyer, or the observer reads another store.",
      fix: "Type the buyer values the runner passes, e-mail included, and point the observer at the store the page writes to.",
    },
  },
  stimulus_not_create: {
    only: {
      observed: (f) => `${f.at}: the buyer's first order appeared in a step with no matched create request.`,
      cause: "The create matcher does not match the request that creates the order.",
      fix: "Point commands.create at the request that creates the order: its method and its path without query.",
    },
  },
  stimulus_not_applied: {
    only: {
      observed: (f) => `${f.at}: the armed withhold met no create request.`,
      cause: "The buyer action sent no request matching the create matcher, so no response was withheld.",
      fix: "Make the action send the create request, or point commands.create at it.",
    },
  },
  request_budget_exceeded: {
    only: {
      observed: (f) => `${f.at}: the run sent ${f.count} create requests; the scenario allows ${f.limit}.`,
      cause: "The page kept sending create requests, so the run stopped before it could exhaust the store's request quota.",
      fix: "Send one create per buyer action and stop retrying a create on its own.",
    },
  },
  outcome_failed: {
    rejected: {
      observed: (f) => `${f.at}: the outcome driver rejected ${f.name} (${f.detail}).`,
      cause: "The outcome driver could not produce the outcome, so the steps after it observe nothing about the store.",
      fix: "Make the outcome driver's sandbox reachable for the harness, or declare only the outcomes it can produce.",
    },
    no_attempt: {
      observed: (f) => `${f.at}: the outcome driver produced ${f.name}, but the ledger shows no payment attempt.`,
      cause: "The outcome resolved but the ledger shows no payment attempt, so it did not act on this run's payment.",
      fix: "Make the page start a payment attempt before the outcome, and the driver act on the run subject's attempt.",
    },
  },
  tier_unreachable: {
    only: {
      observed: (f) => `${f.at}: not admitted; the run's outcome driver does not declare every outcome the scenario requires.`,
      cause: (f) => `The scenario needs the outcomes ${f.detail}, which the run's outcome driver does not declare, so it cannot be proven here.`,
      fix: "Run the scenario where an outcome driver declares these outcomes; until then it is missing evidence, never a pass.",
    },
  },
  page_failed: {
    only: {
      observed: (f) => `${f.at}: the page handle failed (${f.detail}).`,
      cause: "The page could not be driven, so nothing about the store was observed.",
      fix: "Make the page reachable and responsive for the harness, then run the scenario again.",
    },
  },
  observer_failed: {
    rejected: {
      observed: (f) => `${f.at}: the observer rejected (${f.detail}).`,
      cause: "The ledger could not be read, so the run's safety cannot be judged.",
      fix: "Make the observer's store reachable for the harness, then run the scenario again.",
    },
    unattributable: {
      observed: (f) => `${f.at}: the database gained ${f.count} payable orders while the run's buyer gained ${f.limit}.`,
      cause: "Payable orders left the database during the run, so the observer cannot attribute its counts: the database is not exclusive to the run.",
      fix: "Give each proof run a database no other process writes to, or drop payableOrdersInDatabase from an observer that shares one.",
    },
  },
};

/** The observed, cause and fix texts for a code and cause. */
export function findingText(code: string, cause: string, facts: FindingFacts): { observed: string; cause: string; fix: string } {
  const text = texts[code]?.[cause];
  if (text === undefined) throw new TypeError(`storefront runner has no finding text for ${code} (${cause})`);
  return { observed: text.observed(facts), cause: typeof text.cause === "string" ? text.cause : text.cause(facts), fix: text.fix };
}

/** The finding codes and causes the table holds, for its own witness. */
export const findingTextKeys: readonly (readonly [string, string])[] = Object.freeze(
  Object.entries(texts).flatMap(([code, causes]) => Object.keys(causes).map((cause) => Object.freeze([code, cause] as const))),
);
