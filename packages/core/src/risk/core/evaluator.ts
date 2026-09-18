import type { RiskDecision, RiskSeverity } from "../types.js";
import { collectRiskRuleMatches } from "./rules.js";
import type { RiskEvaluationInput, RiskEvaluationOutput } from "./types.js";

const SEVERITY_ORDER: RiskSeverity[] = ["low", "medium", "high", "critical"];

/** @beta */
export function evaluateRisk(input: RiskEvaluationInput): RiskEvaluationOutput {
  const matchedRules = collectRiskRuleMatches(input);
  const score = Math.min(100, matchedRules.reduce((sum, rule) => sum + rule.score, 0));
  const hasBlocklist = matchedRules.some((rule) => rule.code === "exact_blocklist_match");
  const decision = decide(score, hasBlocklist);
  const severity = matchedRules.reduce<RiskSeverity>(
    (max, rule) => (SEVERITY_ORDER.indexOf(rule.severity) > SEVERITY_ORDER.indexOf(max) ? rule.severity : max),
    "low",
  );
  const checkoutBlocked =
    input.source === "checkout" && input.mode === "checkout_blocklist" && hasBlocklist;
  const holdRequested =
    input.source !== "checkout" && input.mode === "hold" && (decision === "manual_review" || decision === "block");

  return {
    decision,
    score,
    severity,
    reasonCodes: matchedRules.map((rule) => rule.code),
    matchedRules,
    enforcement: {
      mode: input.mode,
      applied: input.mode !== "shadow" && (checkoutBlocked || holdRequested),
      checkoutBlocked,
      holdRequested,
    },
  };
}

function decide(score: number, hasBlocklist: boolean): RiskDecision {
  if (hasBlocklist) return "block";
  if (score >= 35) return "manual_review";
  return "allow";
}
