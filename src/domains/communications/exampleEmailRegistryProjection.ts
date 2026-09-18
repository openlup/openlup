import type { DbEmailTemplatePolicy } from "./dbEmailTemplatePolicy.js";
import type { EmailCanonDynamicPattern, EmailCanonEntry } from "./emailCanon.js";
import type { EmailEditGuideEntry } from "./emailEditGuide.js";
import type { CommunicationEmailDynamicRoutingPolicyEntry } from "./emailRoutingPolicyTypes.js";

export type EmailCanonVerification = Pick<
  EmailCanonEntry,
  "mechanism" | "triggerRef" | "verifiedFlag" | "verifiedAt"
>;
export type EmailCanonEntrySeed = Omit<EmailCanonEntry, keyof EmailCanonVerification>;
export type EmailCanonDynamicPatternSeed = Omit<EmailCanonDynamicPattern, keyof EmailCanonVerification>;

export interface ProjectedInsertion<T> {
  readonly beforeSlug: string | null;
  readonly entries: readonly T[];
}

export interface EmailRegistryProjection {
  readonly retiredStaticSlugs: readonly string[];
  readonly staticSlugsWithoutNotificationControl: readonly string[];
  readonly staticCanonInsertions: readonly ProjectedInsertion<EmailCanonEntrySeed>[];
  readonly staticVerificationInsertions: readonly ProjectedInsertion<readonly [string, EmailCanonVerification]>[];
  readonly staticEditGuideInsertions: readonly ProjectedInsertion<EmailEditGuideEntry>[];
  readonly dynamicCanonEntries: readonly EmailCanonDynamicPatternSeed[];
  readonly dynamicVerificationById: Readonly<Record<string, EmailCanonVerification>>;
  readonly dynamicEditGuideEntries: readonly EmailEditGuideEntry[];
  readonly dynamicRoutingEntries: readonly CommunicationEmailDynamicRoutingPolicyEntry[];
  readonly dbTemplatePolicyInsertions: readonly ProjectedInsertion<DbEmailTemplatePolicy>[];
  readonly dbAllowedVariables: readonly string[];
  readonly dbFeedbackTimingForbiddenPatterns: readonly RegExp[];
}

export function insertProjectedEntries<T>(
  base: readonly T[],
  insertions: readonly ProjectedInsertion<T>[],
  keyOf: (entry: T) => string,
): readonly T[] {
  const baseKeys = new Set(base.map(keyOf));
  const insertionKeys = new Set<string>();
  const byAnchor = new Map<string | null, readonly T[]>();
  for (const insertion of insertions) {
    if (insertion.beforeSlug !== null && !baseKeys.has(insertion.beforeSlug)) {
      throw new Error(`Missing projection anchor ${insertion.beforeSlug}`);
    }
    if (byAnchor.has(insertion.beforeSlug)) throw new Error(`Duplicate projection anchor ${insertion.beforeSlug}`);
    for (const entry of insertion.entries) {
      const key = keyOf(entry);
      if (baseKeys.has(key) || insertionKeys.has(key)) throw new Error(`Duplicate projected email key ${key}`);
      insertionKeys.add(key);
    }
    byAnchor.set(insertion.beforeSlug, insertion.entries);
  }
  return [...base.flatMap((entry) => [...(byAnchor.get(keyOf(entry)) ?? []), entry]), ...(byAnchor.get(null) ?? [])];
}

export const emailRegistryProjection: EmailRegistryProjection = Object.freeze({
  retiredStaticSlugs: [],
  staticSlugsWithoutNotificationControl: [],
  staticCanonInsertions: [],
  staticVerificationInsertions: [],
  staticEditGuideInsertions: [],
  dynamicCanonEntries: [],
  dynamicVerificationById: {},
  dynamicEditGuideEntries: [],
  dynamicRoutingEntries: [],
  dbTemplatePolicyInsertions: [],
  dbAllowedVariables: [],
  dbFeedbackTimingForbiddenPatterns: [],
});
