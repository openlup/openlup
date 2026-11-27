import type { StorefrontVerdict } from "../../lifecycle/index.js";

// Internal: imported by the runner and by the witness that the judgement order and
// the finding-text table cover each other. The testing entry does not re-export it,
// so it stays out of the API report.

/** Where a code sits in the judgement order, and the result it gives when it is the first failing check. */
export const JUDGEMENT: Readonly<Record<string, { readonly group: number; readonly rank: number; readonly result: StorefrontVerdict["result"] }>> = {
  tier_unreachable: { group: 0, rank: 0, result: "not_run" },
  page_failed: { group: 1, rank: 0, result: "not_run" },
  "observer_failed:rejected": { group: 1, rank: 0, result: "not_run" },
  arrange_failed: { group: 1, rank: 0, result: "not_run" },
  "outcome_failed:rejected": { group: 1, rank: 0, result: "not_run" },
  observer_subject_unseen: { group: 2, rank: 0, result: "not_run" },
  stimulus_not_create: { group: 3, rank: 0, result: "not_run" },
  stimulus_not_applied: { group: 3, rank: 0, result: "not_run" },
  // An outcome the driver reported but the ledger does not show never counts as stimulus.
  "outcome_failed:no_attempt": { group: 3, rank: 1, result: "not_run" },
  "outcome_failed:no_effect": { group: 3, rank: 1, result: "not_run" },
  // A declared auto-progress the page did not perform explains a missing outcome effect, so it ranks first.
  auto_progress_not_performed: { group: 3, rank: 0, result: "not_run" },
  duplicate_order: { group: 5, rank: 0, result: "failed" },
  duplicate_hold: { group: 5, rank: 0, result: "failed" },
  duplicate_capture: { group: 5, rank: 0, result: "failed" },
  second_attempt: { group: 5, rank: 0, result: "failed" },
  forbidden_state_shown: { group: 5, rank: 0, result: "failed" },
  order_outside_subject: { group: 5, rank: 1, result: "failed" },
  "observer_failed:unattributable": { group: 5, rank: 2, result: "not_run" },
  // The run stopped before its progress and control were exercised, so it proves nothing either way (missing
  // evidence, never a pass); a ledger violation observed before the stop is already proof of harm and outranks it.
  request_budget_exceeded: { group: 5, rank: 3, result: "not_run" },
  adapter_matcher_unmatched: { group: 6, rank: 0, result: "not_run" },
  "adapter_anchor_missing:action": { group: 6, rank: 0, result: "not_run" },
  "adapter_anchor_missing:field": { group: 6, rank: 0, result: "not_run" },
  anchor_hidden: { group: 6, rank: 0, result: "not_run" },
  progress_not_reached: { group: 7, rank: 0, result: "failed" },
  policy_mismatch: { group: 7, rank: 0, result: "failed" },
  "adapter_anchor_missing:state": { group: 7, rank: 0, result: "not_run" },
  control_not_applied: { group: 8, rank: 0, result: "not_run" },
  vacuous_progress: { group: 8, rank: 1, result: "vacuous" },
  auto_progress_undeclared: { group: 8, rank: 1, result: "not_run" },
};
