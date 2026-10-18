import type { OperatorSchema } from "./operatorAuth.js";

export type PrivacySubjectRef = { kind: "contact"; contactId: string } | { kind: "principal"; principalId: string };
export type PrivacyJson = null | boolean | number | string | PrivacyJson[] | { [key: string]: PrivacyJson };
export interface PersonalDataObligation { owner: string; resource: string; disposition: "erase" | "retain" | "unresolved"; reasonCode: string; remote: boolean }
export interface PersonalDataDocument {
  contributorId: string; version: string; data: PrivacyJson;
  coverage: { complete: boolean; included: string[]; unavailable: string[] };
  obligations: PersonalDataObligation[];
}
export interface ErasureReceipt { version: "identity.erasure.v1"; erasureId: string; completedAt: string; outcome: "ERASED" | "ALREADY_ERASED"; obligations: PersonalDataObligation[] }
export interface PrivacyEraseRequest { subject: PrivacySubjectRef; idempotencyKey: string }
export interface PrivacyExport { format: "personal-data.v1"; generatedAt: string; subject: PrivacySubjectRef; documents: PersonalDataDocument[]; missingContributors: string[]; erasure: ErasureReceipt | null }
function invalid(): never { throw new Error("privacy_contract_invalid"); }
function schema<T>(parse: (value: unknown) => T): OperatorSchema<T> {
  return { parse, safeParse(value) { try { return { success: true, data: parse(value) }; } catch { return { success: false, error: new Error("privacy_contract_invalid") }; } } };
}
function fields(value: unknown, keys: string[]): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype
    || Object.keys(value).length !== keys.length || !keys.every(key => Object.hasOwn(value, key))) invalid();
  return value as Record<string, unknown>;
}
function text(value: unknown, max = 200): string {
  if (typeof value !== "string" || !value.length || value.length > max) invalid();
  return value;
}
function uuid(value: unknown): string {
  const result = text(value, 36);
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(result)) invalid();
  return result.toLowerCase();
}
function timestamp(value: unknown): string {
  const result = text(value, 30);
  if (!/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{3})?Z$/.test(result) || !Number.isFinite(Date.parse(result))
    || new Date(result).toISOString() !== result.replace(/Z$/, result.length === 20 ? ".000Z" : "Z")) invalid();
  return result;
}
function list<T>(value: unknown, parse: (element: unknown) => T): T[] {
  if (!Array.isArray(value) || value.length > 10000) invalid();
  return value.map(element => parse(element));
}
function boolean(value: unknown): boolean { if (typeof value !== "boolean") invalid(); return value; }
function choice<T extends string>(value: unknown, allowed: readonly T[]): T { if (!allowed.includes(value as T)) invalid(); return value as T; }
function json(value: unknown, depth = 0): PrivacyJson {
  if (depth > 32) invalid();
  if (value === null || typeof value === "boolean" || typeof value === "string") { if (typeof value === "string" && value.length > 1000000) invalid(); return value; }
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (Array.isArray(value)) return list(value, element => json(element, depth + 1));
  if (!value || typeof value !== "object" || Object.getPrototypeOf(value) !== Object.prototype) invalid();
  const forbidden = new Set(["__proto__", "constructor", "prototype", "password", "password_hash", "token_hash", "access_token", "refresh_token", "accessToken", "refreshToken", "secret", "credentials"]);
  const entries = Object.entries(value);
  if (entries.length > 10000 || entries.some(([key]) => forbidden.has(key))) invalid();
  return Object.fromEntries(entries.map(([key, child]) => [key, json(child, depth + 1)]));
}
export const privacySubjectSchema: OperatorSchema<PrivacySubjectRef> = schema(value => {
  if (!value || typeof value !== "object" || !("kind" in value)) invalid();
  if (value.kind === "contact") { const row = fields(value, ["kind", "contactId"]); return { kind: "contact", contactId: uuid(row.contactId) }; }
  const row = fields(value, ["kind", "principalId"]);
  return { kind: choice(row.kind, ["principal"]), principalId: uuid(row.principalId) };
});
export const personalDataObligationSchema: OperatorSchema<PersonalDataObligation> = schema(value => {
  const row = fields(value, ["owner", "resource", "disposition", "reasonCode", "remote"]);
  return { owner: text(row.owner, 100), resource: text(row.resource), disposition: choice(row.disposition, ["erase", "retain", "unresolved"]), reasonCode: text(row.reasonCode, 100), remote: boolean(row.remote) };
});
export const personalDataDocumentSchema: OperatorSchema<PersonalDataDocument> = schema(value => {
  const row = fields(value, ["contributorId", "version", "data", "coverage", "obligations"]), coverage = fields(row.coverage, ["complete", "included", "unavailable"]);
  const contributorId = text(row.contributorId, 100), version = text(row.version);
  if (!/^[a-z][a-z0-9.-]{0,99}$/.test(contributorId) || !/^[a-z][a-z0-9.-]*\.v[1-9][0-9]*$/.test(version)) invalid();
  return { contributorId, version, data: json(row.data), coverage: { complete: boolean(coverage.complete), included: list(coverage.included, text), unavailable: list(coverage.unavailable, text) }, obligations: list(row.obligations, personalDataObligationSchema.parse) };
});
export const erasureReceiptSchema: OperatorSchema<ErasureReceipt> = schema(value => {
  const row = fields(value, ["version", "erasureId", "completedAt", "outcome", "obligations"]);
  return { version: choice(row.version, ["identity.erasure.v1"]), erasureId: uuid(row.erasureId), completedAt: timestamp(row.completedAt), outcome: choice(row.outcome, ["ERASED", "ALREADY_ERASED"]), obligations: list(row.obligations, personalDataObligationSchema.parse) };
});
export const privacyExportRequestSchema: OperatorSchema<{ subject: PrivacySubjectRef }> = schema(value => ({ subject: privacySubjectSchema.parse(fields(value, ["subject"]).subject) }));
export const privacyEraseRequestSchema: OperatorSchema<PrivacyEraseRequest> = schema(value => {
  const row = fields(value, ["subject", "idempotencyKey"]); return { subject: privacySubjectSchema.parse(row.subject), idempotencyKey: uuid(row.idempotencyKey) };
});
export const privacyExportResponseSchema: OperatorSchema<PrivacyExport> = schema(value => {
  const row = fields(value, ["format", "generatedAt", "subject", "documents", "missingContributors", "erasure"]);
  return { format: choice(row.format, ["personal-data.v1"]), generatedAt: timestamp(row.generatedAt), subject: privacySubjectSchema.parse(row.subject), documents: list(row.documents, personalDataDocumentSchema.parse), missingContributors: list(row.missingContributors, text), erasure: row.erasure === null ? null : erasureReceiptSchema.parse(row.erasure) };
});
export const privacyEraseResponseSchema = erasureReceiptSchema;
const refusalCodes = ["PRIVACY_SUBJECT_NOT_FOUND", "PRIVACY_CONTRIBUTOR_DUPLICATE", "PRIVACY_CONTRIBUTOR_MISSING", "PRIVACY_ASSESSMENT_UNAVAILABLE", "PRIVACY_OWNERSHIP_UNDECLARED", "PRIVACY_ACTIVE_SUBSCRIPTION", "PRIVACY_RESUMABLE_SUBSCRIPTION", "PRIVACY_PROTECTED_OPERATOR", "PRIVACY_IDEMPOTENCY_CONFLICT", "PRIVACY_SUBJECT_ERASED", "PRIVACY_STORE_PRIVILEGES_UNSAFE", "MANAGED_PRIVACY_ERASURE_UNAVAILABLE"] as const;
export type PrivacyRefusalCode = typeof refusalCodes[number];
export const privacyRefusalCodeSchema: OperatorSchema<PrivacyRefusalCode> = schema(value => choice(value, refusalCodes));
