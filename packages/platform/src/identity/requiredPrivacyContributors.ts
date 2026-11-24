import { PrivacyRefusal, type PrivacyRefusalFacts } from "./privacyPorts.js";

const contributorId = /^[a-z][a-z0-9.-]{0,99}$/u;
const projectedFacts = new WeakMap<PrivacyRefusal, PrivacyRefusalFacts>();

/** Verify the bounded, unique, C-sorted declaration used in native operations and transfers. */
export function validateRequiredPrivacyContributorIds(value: unknown): readonly string[] {
  if (!Array.isArray(value) || value.length < 1 || value.length > 10_000) throw new Error("privacy_declaration_invalid");
  let previous = "";
  for (const id of value) {
    if (typeof id !== "string" || !contributorId.test(id) || id <= previous) throw new Error("privacy_declaration_invalid");
    previous = id;
  }
  if (!value.includes("identity")) throw new Error("privacy_declaration_invalid");
  return value;
}

function governedRefusal(code: "PRIVACY_CONTRIBUTOR_MISSING" | "PRIVACY_ASSESSMENT_UNAVAILABLE", facts: PrivacyRefusalFacts, cause?: unknown) {
  const error = new PrivacyRefusal(code);
  projectedFacts.set(error, Object.freeze(facts));
  Object.defineProperty(error, "facts", { value: facts, enumerable: true });
  if (code === "PRIVACY_ASSESSMENT_UNAVAILABLE") Object.defineProperty(error, "cause", { value: cause });
  return error;
}

export function privacyRefusalDetails(error: PrivacyRefusal) {
  return { privacyCode: error.code, ...projectedFacts.get(error) };
}

export function nativePrivacyUnavailable(cause: unknown): PrivacyRefusal {
  return governedRefusal("PRIVACY_ASSESSMENT_UNAVAILABLE", {
    observed: "Native privacy prerequisites could not be verified.",
    cause: "The native store or its installed declaration is unavailable or invalid.",
    fix: "Check the native handler and store binding, driver, connection and TLS, and CONNECT, schema USAGE and EXECUTE privileges. Ask the installation owner to recover the exact declared catalogue and its approved migration history.",
    recheck: "Retry the original request.",
  }, cause);
}

export function missingPrivacyContributors(ids: readonly string[], installed: boolean): PrivacyRefusal {
  const labels = [...new Set(ids)].filter(id => contributorId.test(id)).sort().slice(0, 10_000).join(", ");
  return governedRefusal("PRIVACY_CONTRIBUTOR_MISSING", {
    observed: `Required ${installed ? "installed" : "local"} owners are absent${labels ? ` (${labels})` : ""}.`,
    cause: installed ? "The installed declaration requires those owners." : "The handler composition or its host-only expectations are incomplete.",
    fix: installed ? "Register their working owner ports in the serving composition."
      : "Register the owner or correct an erroneous host-only expectation while preserving installed requirements.",
    recheck: installed ? "Retry the original request after rollout." : "Retry the original subject and key.",
  });
}
