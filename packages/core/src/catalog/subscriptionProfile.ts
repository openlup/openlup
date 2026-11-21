import { z } from "zod";
import { cadenceChoiceV1Schema, fixedCadenceDaysSchema, type CadenceChoiceV1 } from "../subscription/cadenceChoice.js";

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

/** @experimental */
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
};

/** Validate v1 install metadata and normalize the order of the cadence set.
 * @experimental
 */
export function validateCatalogSubscriptionProfile(input: unknown):
  { profile: CatalogSubscriptionProfileV1 } | { issue: CatalogSubscriptionProfileIssue } {
  const parsed = schema.safeParse(input);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    return { issue: { code: "definition_profile_invalid", path: issue.path.map(value => `/${String(value)}`).join("") } };
  }
  const { allowedCadences, maxFixedDays, ...profile } = parsed.data;
  const days: number[] = [];
  for (const [index, choice] of allowedCadences.entries()) {
    if (choice.kind !== "fixed_days") return { issue: { code: "cadence_kind_unsupported", path: `/allowedCadences/${index}` } };
    days.push(choice.days);
  }
  if (new Set(days).size !== days.length) return { issue: { code: "definition_profile_invalid", path: "/allowedCadences" } };
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
