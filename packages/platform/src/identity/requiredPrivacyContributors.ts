import { PrivacyRefusal, type PrivacyRefusalFacts } from "./privacyPorts.js";
import type { PrivacyRefusalCode } from "./contracts/privacy.js";

export const privacyContributorId = /^[a-z][a-z0-9.-]{0,99}$/u;
export const privacyContributorVersion = /^[a-z][a-z0-9.-]*\.v[1-9][0-9]*$/u;
const projectedFacts = new WeakMap<PrivacyRefusal, PrivacyRefusalFacts>();

export function validateOrderedPrivacyContributorIds(value: unknown, maximum: number): readonly string[] {
  if (!Array.isArray(value) || value.length > maximum) throw new Error("privacy_contributor_ids_invalid");
  let previous = "";
  for (const id of value) {
    if (typeof id !== "string" || !privacyContributorId.test(id) || id <= previous) throw new Error("privacy_contributor_ids_invalid");
    previous = id;
  }
  return [...value];
}

/** Verify the bounded, unique, C-sorted declaration used in native operations and transfers. */
export function validateRequiredPrivacyContributorIds(value: unknown): readonly string[] {
  const ids = validateOrderedPrivacyContributorIds(value, 10_000);
  if (!ids.includes("identity")) throw new Error("privacy_declaration_invalid");
  return ids;
}

export function recognizeReceiptContributorIds(value: unknown): string[] {
  if (!value || typeof value !== "object" || Object.getPrototypeOf(value) !== Object.prototype) return [];
  const entries = Object.entries(value);
  if (entries.length > 10_000 || entries.some(([id, version]) =>
    !privacyContributorId.test(id) || typeof version !== "string" || !privacyContributorVersion.test(version))) return [];
  return entries.map(([id]) => id);
}

function governedRefusal(code: PrivacyRefusalCode, facts: PrivacyRefusalFacts, cause?: unknown) {
  const error = new PrivacyRefusal(code);
  projectedFacts.set(error, Object.freeze(facts));
  Object.defineProperty(error, "facts", { value: facts, enumerable: true });
  if (code === "PRIVACY_ASSESSMENT_UNAVAILABLE") Object.defineProperty(error, "cause", { value: cause });
  return error;
}

export function privacyRefusalDetails(error: PrivacyRefusal) {
  return { privacyCode: error.code, ...projectedFacts.get(error) };
}

export function nativePrivacyUnavailable(cause: unknown, facts: PrivacyRefusalFacts = {
  observed: "Native privacy prerequisites could not be verified.",
  cause: "The native store or its installed declaration or receipt evidence is unavailable or invalid.",
  fix: "Check the native handler and store binding, driver, connection and TLS, and CONNECT, schema USAGE and EXECUTE privileges. Ask the installation owner to recover the exact declared catalogue and its approved migration history or the original verified receipt evidence, as applicable.",
  recheck: "Retry the original request.",
}): PrivacyRefusal {
  return governedRefusal("PRIVACY_ASSESSMENT_UNAVAILABLE", facts, cause);
}

export function missingPrivacyContributors(ids: readonly string[], installed: boolean): PrivacyRefusal {
  const labels = [...new Set(ids)].filter(id => privacyContributorId.test(id)).sort().slice(0, 10_000).join(", ");
  return governedRefusal("PRIVACY_CONTRIBUTOR_MISSING", {
    observed: `Required ${installed ? "installed" : "local"} owners are absent${labels ? ` (${labels})` : ""}.`,
    cause: installed ? "The installed declaration requires those owners." : "The handler composition or its host-only expectations are incomplete.",
    fix: installed ? "Register their working owner ports in the serving composition."
      : "Register the owner or correct an erroneous host-only expectation while preserving installed requirements.",
    recheck: installed ? "Retry the original request after rollout." : "Retry the original subject and key.",
  });
}

export function incompletePrivacyReceiptCoverage(ids: readonly string[]): PrivacyRefusal {
  return governedRefusal("PRIVACY_RECEIPT_COVERAGE_INCOMPLETE", {
    observed: `A prior erasure is missing recorded coverage for the required owners (${ids.join(", ")}).`,
    cause: "The original receipt and verified owner approvals do not establish their local disposition.",
    fix: "Ask the data privacy owner and contributor owners to reconcile the missing coverage against the original receipt.",
    recheck: "Retry the original erasure request after reconciliation.",
  });
}

export function unverifiedPrivacyReconciliationApproval(reason: "binding" | "disposition" = "binding"): PrivacyRefusal {
  if (reason === "disposition") {
    return governedRefusal("PRIVACY_RECONCILIATION_APPROVAL_UNVERIFIED", {
      observed: "The contributor's reconciliation disposition could not be verified.",
      cause: "The disposition is malformed, does not match the registered contributor, or contains an unresolved obligation.",
      fix: "Correct the contributor's result to match its registration and settle unresolved obligations through their owners.",
      recheck: "Retry with the same verified approval binding, then replay the original subject and idempotency key.",
    });
  }
  return governedRefusal("PRIVACY_RECONCILIATION_APPROVAL_UNVERIFIED", {
    observed: "The approval reference could not be bound to this erasure and owner.",
    cause: "The receipt or contributor is outside this installation's declared scope, or the pair and reference are already bound differently.",
    fix: "Have the installation owner verify the original approval in local custody and use its verified receipt, contributor and reference.",
    recheck: "Retry the owner operation with that binding.",
  });
}
