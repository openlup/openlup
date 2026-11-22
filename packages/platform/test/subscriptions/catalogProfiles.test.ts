import { createHash } from "node:crypto";
import { canonicalCatalogSubscriptionProfileJson, validateCatalogSubscriptionProfile, type CatalogSubscriptionProfileV1 } from "@openlup/core/catalog";
import { parseCadenceChoiceV1, type CadenceChoiceV1 } from "@openlup/core/subscription";
import { describe, expect, it, vi } from "vitest";
import { createPostgresSubscriptionCommandStore, selectCatalogProfileCadence, type CatalogProfileCadenceInput } from "../../src/subscriptions/index.js";

const fixed = (days: number) => ({ schemaVersion: 1, kind: "fixed_days", days } as const);
const calendar = { schemaVersion: 1, kind: "calendar_months", months: 1 } as const;
const ref = { key: "example:repeat", version: 1 };
const declaration: CatalogSubscriptionProfileV1 = {
  ...ref, allowedCadences: [1, 30, 120, 121, 3660].map(fixed),
  policyRef: { key: "example:policy", version: 1 }, policyDigest: "a".repeat(64),
};
function identity(input: CatalogSubscriptionProfileV1) {
  const checked = validateCatalogSubscriptionProfile(input);
  if ("issue" in checked) throw new Error("Invalid profile fixture");
  return {
    profileKey: input.key, profileVersion: input.version, policyRef: input.policyRef, policyDigest: input.policyDigest,
    profileDigest: createHash("sha256").update(canonicalCatalogSubscriptionProfileJson(checked.profile)).digest("hex"),
  };
}
const installed = identity(declaration);
const request = (choice: CadenceChoiceV1): CatalogProfileCadenceInput => ({
  choice, mode: "recurring",
  storeChoices: declaration.allowedCadences, skuChoices: declaration.allowedCadences,
  offerChoices: declaration.allowedCadences, commandChoices: declaration.allowedCadences,
  profileRef: ref, profile: { declaration, installed },
});

describe("SP1-D-022 profile cadence admission", () => {
  it("refuses an explicit missing profile and a mismatched policy pin", () => {
    const input = request(fixed(30));
    expect(selectCatalogProfileCadence({ ...input, profile: undefined })).toEqual({ code: "profile_missing" });
    expect(selectCatalogProfileCadence({ ...input, profileRef: { ...ref, version: 99 } })).toEqual({ code: "profile_missing" });
    expect(selectCatalogProfileCadence({
      ...input, profile: { declaration, installed: { ...installed, policyDigest: "b".repeat(64) } },
    })).toEqual({ code: "policy_binding_missing" });
    expect(selectCatalogProfileCadence({ ...input, profileRef: undefined, profile: undefined })).toEqual({ cadenceDays: 30 });
  });

  it("keeps the native prepaid refusal for unprofiled requests and the profile-specific refusal for profiled requests", async () => {
    const withTransaction = vi.fn(async () => { throw new Error("prepaid must refuse before a database call"); });
    const store = createPostgresSubscriptionCommandStore({ withTransaction });
    const input = request(fixed(30));
    const unprofiled = { ...input, mode: "prepaid", profileRef: undefined, profile: undefined } as const;
    const legacy = { actorId: "actor", clientId: "client", subscriptionId: "subscription",
      idempotencyKey: "prepaid-unsupported", action: "multi_cycle_prepaid", payload: { cadenceDays: 30 },
      now: "2099-01-01T00:00:00Z" };
    const refusal = { status: "refused", reason: "multi_cycle_prepaid_unsupported" };
    expect(await store.preview(legacy)).toEqual(refusal);
    expect(await store.apply(legacy)).toEqual(refusal);
    expect(withTransaction).not.toHaveBeenCalled();
    expect(selectCatalogProfileCadence(unprofiled)).toEqual({ code: refusal.reason });
    expect(selectCatalogProfileCadence({ ...input, mode: "prepaid" })).toEqual({ code: "prepaid_unsupported" });
  });

  it("intersects the store, SKU, offer, command and profile choices", () => {
    const input = request(fixed(30));
    for (const field of ["storeChoices", "skuChoices", "offerChoices", "commandChoices"] as const) {
      expect(selectCatalogProfileCadence({ ...input, [field]: [fixed(31)] })).toEqual({ code: "cadence_not_offered" });
    }
    const different = { ...declaration, allowedCadences: [fixed(31)] };
    expect(selectCatalogProfileCadence({ ...input, profile: { declaration: different, installed: identity(different) } }))
      .toEqual({ code: "cadence_not_offered" });
  });
});

describe("SP1-D-026 fixed-day bounds", () => {
  it("admits 1 and 3660, rejects 3661 and intersects an optional 120-day cap", () => {
    for (const days of [1, 3660]) expect(selectCatalogProfileCadence(request(fixed(days)))).toEqual({ cadenceDays: days });
    expect(selectCatalogProfileCadence(request(fixed(3661)))).toEqual({ code: "cadence_not_offered" });
    const capped = { ...declaration, maxFixedDays: 120 };
    const profile = { declaration: capped, installed: identity(capped) };
    expect(selectCatalogProfileCadence({ ...request(fixed(120)), profile })).toEqual({ cadenceDays: 120 });
    expect(selectCatalogProfileCadence({ ...request(fixed(121)), profile })).toEqual({ code: "cadence_not_offered" });
  });

  it("round-trips the reserved choice but refuses it in declarations and selection", () => {
    expect(parseCadenceChoiceV1(JSON.parse(JSON.stringify(calendar)))).toEqual(calendar);
    expect(parseCadenceChoiceV1(JSON.parse(JSON.stringify(fixed(30))))).toEqual(fixed(30));
    expect(parseCadenceChoiceV1({ ...fixed(30), schemaVersion: 2 })).toBeNull();
    expect(parseCadenceChoiceV1({ ...fixed(30), days: 1.5 })).toBeNull();
    expect(parseCadenceChoiceV1(fixed(0))).toBeNull();
    for (const allowedCadences of [[calendar], [fixed(30), calendar]]) {
      expect(validateCatalogSubscriptionProfile({ ...declaration, allowedCadences })).toMatchObject({ issue: { code: "cadence_kind_unsupported" } });
    }
    expect(selectCatalogProfileCadence({ ...request(calendar), cadenceDays: 30 })).toEqual({ code: "cadence_kind_unsupported" });
    expect(selectCatalogProfileCadence({ ...request(fixed(30)), cadenceDays: 31 })).toEqual({ code: "cadence_day_projection_mismatch" });
    expect(validateCatalogSubscriptionProfile({ ...declaration, allowedCadences: [fixed(30), fixed(30)] }))
      .toMatchObject({ issue: { code: "definition_profile_invalid" } });
  });
});

it("canonicalizes declaration key order and the cadence set to one digest", () => {
  const reordered = { policyDigest: declaration.policyDigest, policyRef: declaration.policyRef, ...ref,
    allowedCadences: [...declaration.allowedCadences].reverse() };
  expect(identity(reordered)).toEqual(installed);
  expect(selectCatalogProfileCadence({ ...request(fixed(30)), profile: { declaration: reordered, installed } }))
    .toEqual({ cadenceDays: 30 });
});

it.each([
  ["allowedCadences/0/days", { allowedCadences: [fixed(3661)] }],
  ["maxFixedDays", { maxFixedDays: 3661 }],
] as const)("refuses %s outside the whole-day bounds", (path, change) => {
  expect(validateCatalogSubscriptionProfile({ ...declaration, ...change })).toMatchObject({
    issue: { code: "definition_profile_invalid", path: `/${path}`, fix: expect.stringContaining("1 to 3660") },
  });
});

it.each([
  ["policyDigest", { policyDigest: "abc" }, "Supply policyDigest as a 64-character lowercase SHA-256 hex digest."],
  ["policyRef/displayLabel", { policyRef: { ...declaration.policyRef, displayLabel: "example" } },
    'Remove the unexpected property "displayLabel".'],
  ["allowedCadences/0/schemaVersion", { allowedCadences: [{ ...fixed(30), schemaVersion: 2 }] },
    "Use schemaVersion 1 for this cadence choice."],
] as const)("preserves the remedy for an invalid %s from declaration to selector", (path, change, fix) => {
  const badDeclaration = { ...declaration, ...change } as unknown as CatalogSubscriptionProfileV1;
  const issue = { code: "definition_profile_invalid", path: `/${path}`, fix };
  expect(validateCatalogSubscriptionProfile(badDeclaration)).toEqual({ issue });
  expect(selectCatalogProfileCadence({ ...request(fixed(30)), profile: { declaration: badDeclaration, installed } }))
    .toEqual({ code: "policy_binding_missing", issue });
});
