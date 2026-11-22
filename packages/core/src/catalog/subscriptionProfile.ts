import { z } from "zod";
import { cadenceChoiceV1Schema, fixedCadenceDaysSchema, type CadenceChoiceV1 } from "../subscription/cadenceChoice.js";
import { MAX_CADENCE_DAYS } from "../subscription/types.js";

/** @experimental */
export interface CatalogSubscriptionProfileRef {
  readonly key: string;
  readonly version: number;
}

/** @experimental */
export interface CatalogSubscriptionProfileV1 extends CatalogSubscriptionProfileRef {
  readonly allowedCadences: readonly CadenceChoiceV1[];
  readonly maxFixedDays?: number;
  readonly policyRef: CatalogSubscriptionProfileRef;
  readonly policyDigest: string;
}

/** Profile and policy identity pins supplied to the cadence selector.
 * @experimental
 */
export interface InstalledCatalogSubscriptionProfile {
  readonly profileKey: string;
  readonly profileVersion: number;
  readonly profileDigest: string;
  readonly policyRef: CatalogSubscriptionProfileRef;
  readonly policyDigest: string;
}

const profileRef = z.strictObject({
  key: z.string().max(120).regex(/^[a-z][a-z0-9.-]*:[a-z][a-z0-9._-]*$/u),
  version: z.number().int().min(1).max(2147483647),
});
const schema = profileRef.extend({
  allowedCadences: z.array(cadenceChoiceV1Schema).min(1),
  maxFixedDays: fixedCadenceDaysSchema.optional(),
  policyRef: profileRef,
  policyDigest: z.string().regex(/^[0-9a-f]{64}$/u),
});

/** @experimental */
export type CatalogSubscriptionProfileIssue = {
  readonly code: "definition_profile_invalid" | "cadence_kind_unsupported";
  readonly path: string;
  readonly fix: string;
};

const cadenceFix = `Use distinct fixed-day choices with whole days from 1 to ${MAX_CADENCE_DAYS}.`;

function fieldFix([field, child, property]: readonly PropertyKey[]): string {
  switch (field) {
    case "policyDigest":
      return "Supply policyDigest as a 64-character lowercase SHA-256 hex digest.";
    case "allowedCadences":
      return property === "schemaVersion" ? "Use schemaVersion 1 for this cadence choice." : cadenceFix;
    case "maxFixedDays":
      return `Supply a whole number from 1 to ${MAX_CADENCE_DAYS} for maxFixedDays or omit it.`;
    case "policyRef":
      if (child === "key") return "Supply a lowercase namespaced policy key of at most 120 characters, such as example:monthly.";
      if (child === "version") return "Supply a whole-number policy version from 1 to 2147483647.";
      return "Supply policyRef with a namespaced key and a version from 1 to 2147483647.";
    case "key":
      return "Supply a lowercase namespaced profile key of at most 120 characters, such as example:monthly.";
    case "version":
      return "Supply a whole-number profile version from 1 to 2147483647.";
    default:
      return "Supply a subscription profile declaration with the documented fields.";
  }
}

/** Validate profile metadata and normalize the order of the cadence set.
 * @experimental
 */
export function validateCatalogSubscriptionProfile(input: unknown):
  { profile: CatalogSubscriptionProfileV1 } | { issue: CatalogSubscriptionProfileIssue } {
  const parsed = schema.safeParse(input);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    const unexpected = issue.code === "unrecognized_keys" ? issue.keys[0] : undefined;
    const segments = unexpected === undefined ? issue.path : [...issue.path, unexpected];
    const path = segments.map(value => `/${String(value).replaceAll("~", "~0").replaceAll("/", "~1")}`).join("");
    const fix = unexpected === undefined ? fieldFix(issue.path) : `Remove the unexpected property ${JSON.stringify(unexpected)}.`;
    return { issue: { code: "definition_profile_invalid", path, fix } };
  }
  const { allowedCadences, maxFixedDays, ...profile } = parsed.data;
  const days: number[] = [];
  for (const [index, choice] of allowedCadences.entries()) {
    if (choice.kind !== "fixed_days") return { issue: { code: "cadence_kind_unsupported", path: `/allowedCadences/${index}`, fix: cadenceFix } };
    days.push(choice.days);
  }
  if (new Set(days).size !== days.length) return { issue: { code: "definition_profile_invalid", path: "/allowedCadences", fix: cadenceFix } };
  return { profile: Object.freeze({
    ...profile, policyRef: Object.freeze(profile.policyRef),
    allowedCadences: Object.freeze(days.sort((a, b) => a - b)
      .map(days => Object.freeze({ schemaVersion: 1, kind: "fixed_days", days } as const))),
    ...(maxFixedDays === undefined ? {} : { maxFixedDays }),
  }) };
}

/** Canonical SHA-256 input for a declaration returned by the v1 validator.
 * @experimental
 */
export function canonicalCatalogSubscriptionProfileJson(profile: CatalogSubscriptionProfileV1): string {
  return JSON.stringify(profile, (_key, value: unknown) => {
    if (!value || typeof value !== "object" || Array.isArray(value)) return value;
    const record = value as Record<string, unknown>;
    return Object.fromEntries(Object.keys(record).sort().map(key => [key, record[key]]));
  });
}
