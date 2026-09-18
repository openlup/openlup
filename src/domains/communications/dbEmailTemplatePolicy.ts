import { emailRegistryProjection, insertProjectedEntries } from "#email-registry-projection";
import { findEmailCanonEntry } from "./emailCanon.js";

export type DbEmailTemplateSlug = string & {};
export type DbEmailTemplateLocalePolicy = "pl_only_admin" | (string & {});

export interface DbEmailTemplatePolicy {
  slug: DbEmailTemplateSlug;
  owner: string;
  activeRuntime: boolean;
  recipientKind: "admin_internal" | (string & {});
  triggerSource: string;
  triggerEvent: string;
  timing: string;
  localePolicy: DbEmailTemplateLocalePolicy;
  requiredVariables: readonly string[];
  requiredHtmlOnlyVariables?: readonly string[];
  optionalVariables: readonly string[];
  subjectSnapshot: string;
  bodyTextSnapshot: string;
}

const DB_EMAIL_TEMPLATE_POLICY_BASE = [] as const satisfies readonly DbEmailTemplatePolicy[];

export const DB_EMAIL_TEMPLATE_POLICY = insertProjectedEntries(
  DB_EMAIL_TEMPLATE_POLICY_BASE,
  emailRegistryProjection.dbTemplatePolicyInsertions,
  (entry) => entry.slug,
);

const PUBLIC_DB_EMAIL_TEMPLATE_ALLOWED_VARIABLES = [
  "email_origin",
] as const;
export const DB_EMAIL_TEMPLATE_ALLOWED_VARIABLES = [
  ...PUBLIC_DB_EMAIL_TEMPLATE_ALLOWED_VARIABLES,
  ...emailRegistryProjection.dbAllowedVariables,
].sort();

export function isDbEmailTemplateEditorAllowed(slug: string): boolean {
  const canon = findEmailCanonEntry(slug);
  if (canon?.renderer !== "no_send_decision") return true;
  return DB_EMAIL_TEMPLATE_POLICY.some((entry) => entry.slug === slug);
}

export const FEEDBACK_TIMING_COPY_FORBIDDEN_PATTERNS =
  emailRegistryProjection.dbFeedbackTimingForbiddenPatterns;

export function extractTemplateVariables(template: string): string[] {
  return [...new Set([...template.matchAll(/\{\{(\w+)\}\}/g)].map((match) => match[1]))].sort();
}
