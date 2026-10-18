import { expect, it } from "vitest";
import { privacyEraseRequestSchema, personalDataDocumentSchema, privacyExportRequestSchema } from "../../src/identity/contracts/privacy.js";
const subject = { kind: "contact", contactId: "11111111-1111-4111-8111-111111111111" };
it("strict requests reject unknown keys and malformed subjects", () => {
  expect(privacyExportRequestSchema.safeParse({ subject }).success).toBe(true);
  for (const value of [{ subject, token: "secret" }, { subject: { ...subject, principalId: subject.contactId } }, { subject: { kind: "contact", contactId: "bad" } }]) expect(privacyExportRequestSchema.safeParse(value).success).toBe(false);
  expect(privacyEraseRequestSchema.safeParse({ subject }).success).toBe(false);
  const upper = "AAAAAAAA-AAAA-4AAA-8AAA-AAAAAAAAAAAA";
  expect(privacyEraseRequestSchema.parse({ subject: { kind: "contact", contactId: upper }, idempotencyKey: upper })).toEqual({ subject: { kind: "contact", contactId: upper.toLowerCase() }, idempotencyKey: upper.toLowerCase() });
});
it("versioned documents reject malformed JSON, credentials and invalid versions", () => {
  const document = { contributorId: "identity", version: "identity.personal-data.v1", data: { email: "person@example.com" }, coverage: { complete: false, included: [], unavailable: [] }, obligations: [] };
  expect(personalDataDocumentSchema.safeParse(document).success).toBe(true);
  for (const value of [{ ...document, version: "unknown" }, { ...document, data: { nested: [{ token_hash: "credential" }] } }, { ...document, data: { value: Infinity } }]) expect(personalDataDocumentSchema.safeParse(value).success).toBe(false);
});

it("JSON documents reject nonfinite numbers, excessive depth and credential objects", () => {
  const base = { contributorId: "identity", version: "identity.personal-data.v1", coverage: { complete: true, included: ["profile"], unavailable: [] }, obligations: [] };
  let deep: unknown = null; for (let i = 0; i < 34; i++) deep = { value: deep };
  for (const data of [NaN, undefined, new Date(), deep, { password: "excluded" }]) expect(personalDataDocumentSchema.safeParse({ ...base, data }).success).toBe(false);
});
