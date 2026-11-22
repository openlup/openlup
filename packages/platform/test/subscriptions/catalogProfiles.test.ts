import { createHash } from "node:crypto";
import { canonicalCatalogSubscriptionProfileJson, validateCatalogSubscriptionProfile, type CatalogSubscriptionProfileIssue,
  type CatalogSubscriptionProfileV1 } from "@openlup/core/catalog";
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

  it("refuses a stale profile digest with matching policy pins", () => {
    const input = request(fixed(30));
    const updated = { ...declaration, maxFixedDays: 120 };
    expect(selectCatalogProfileCadence({ ...input, profile: { declaration: updated, installed } }))
      .toEqual({ code: "policy_binding_missing" });
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
      .toEqual({ issue: {
        code: "definition_profile_invalid", path: "/allowedCadences",
        fix: "Use distinct fixed-day choices with whole days from 1 to 3660.",
      } });
  });
});

it("canonicalizes declaration key order and the cadence set to one digest", () => {
  const reordered = { policyDigest: declaration.policyDigest, policyRef: declaration.policyRef, ...ref,
    allowedCadences: [...declaration.allowedCadences].reverse() };
  expect(identity(reordered)).toEqual(installed);
  expect(selectCatalogProfileCadence({ ...request(fixed(30)), profile: { declaration: reordered, installed } }))
    .toEqual({ cadenceDays: 30 });
});

const remedies = {
  key: "Supply a lowercase namespaced profile key of at most 120 characters, such as example:monthly.",
  version: "Supply a whole-number profile version from 1 to 2147483647.",
  choice: 'Supply a fixed-day choice such as { schemaVersion: 1, kind: "fixed_days", days: 30 }.',
  schemaVersion: "Use schemaVersion 1 for this cadence choice.",
  kind: 'Use kind "fixed_days" for this cadence choice.',
  days: "Use a fixed-day choice with a days field containing a whole number from 1 to 3660.",
  maxFixedDays: "Supply a whole number from 1 to 3660 for maxFixedDays or omit it.",
  policyRef: 'Supply a policyRef object such as { key: "example:monthly", version: 1 }.',
  policyKey: "Supply a lowercase namespaced policy key of at most 120 characters, such as example:monthly.",
  policyVersion: "Supply a whole-number policy version from 1 to 2147483647.",
  policyDigest: "Supply policyDigest as a 64-character lowercase SHA-256 hex digest.",
  unexpected: 'Remove the unexpected property "extra~/field".',
};
const withChoice = (choice: unknown) => ({ ...declaration, allowedCadences: [choice] });
const withPolicyRef = (policyRef: unknown) => ({ ...declaration, policyRef });
const longKey = `example:${"a".repeat(113)}`;

it.each<[string, unknown, string, string, CatalogSubscriptionProfileIssue["code"]?]>([
  ["non-object declaration", null, "", "Supply a subscription profile declaration object with the documented fields."],
  ["unknown declaration key", { ...declaration, "extra~/field": true }, "/extra~0~1field", remedies.unexpected],

  ["missing key", { ...declaration, key: undefined }, "/key", remedies.key],
  ["wrong key type", { ...declaration, key: 1 }, "/key", remedies.key],
  ["key too long", { ...declaration, key: longKey }, "/key", remedies.key],
  ["invalid key format", { ...declaration, key: "Monthly" }, "/key", remedies.key],
  ["empty key", { ...declaration, key: "" }, "/key", remedies.key],
  ["missing version", { ...declaration, version: undefined }, "/version", remedies.version],
  ["wrong version type", { ...declaration, version: "1" }, "/version", remedies.version],
  ["version too small", { ...declaration, version: 0 }, "/version", remedies.version],
  ["version too large", { ...declaration, version: 2147483648 }, "/version", remedies.version],
  ["fractional version", { ...declaration, version: 1.5 }, "/version", remedies.version],

  ["missing allowedCadences", { ...declaration, allowedCadences: undefined }, "/allowedCadences",
    'Supply allowedCadences as an array, such as [{ schemaVersion: 1, kind: "fixed_days", days: 30 }].'],
  ["wrong allowedCadences type", { ...declaration, allowedCadences: fixed(30) }, "/allowedCadences",
    'Wrap the cadence choice in an array: allowedCadences: [{ schemaVersion: 1, kind: "fixed_days", days }].'],
  ["empty allowedCadences", { ...declaration, allowedCadences: [] }, "/allowedCadences",
    'Add at least one fixed-day choice, such as { schemaVersion: 1, kind: "fixed_days", days: 30 }.'],
  ["duplicate days", { ...declaration, allowedCadences: [fixed(30), fixed(30)] }, "/allowedCadences",
    "Use distinct fixed-day choices with whole days from 1 to 3660."],
  ["non-object choice", withChoice(null), "/allowedCadences/0", remedies.choice],
  ["empty choice", withChoice({}), "/allowedCadences/0/kind", remedies.choice],
  ["unknown choice key", withChoice({ ...fixed(30), "extra~/field": true }), "/allowedCadences/0/extra~0~1field", remedies.unexpected],
  ["missing schemaVersion", withChoice({ kind: "fixed_days", days: 30 }), "/allowedCadences/0/schemaVersion", remedies.choice],
  ["wrong schemaVersion type", withChoice({ ...fixed(30), schemaVersion: "1" }), "/allowedCadences/0/schemaVersion", remedies.schemaVersion],
  ["unsupported schemaVersion", withChoice({ ...fixed(30), schemaVersion: 2 }), "/allowedCadences/0/schemaVersion", remedies.schemaVersion],
  ["missing kind", withChoice({ schemaVersion: 1, days: 30 }), "/allowedCadences/0/kind", remedies.choice],
  ["wrong kind type", withChoice({ ...fixed(30), kind: 1 }), "/allowedCadences/0/kind", remedies.kind],
  ["unknown kind value", withChoice({ ...fixed(30), kind: "weekly" }), "/allowedCadences/0/kind", remedies.kind],
  ["empty kind", withChoice({ ...fixed(30), kind: "" }), "/allowedCadences/0/kind", remedies.kind],
  ["missing days", withChoice({ schemaVersion: 1, kind: "fixed_days" }), "/allowedCadences/0/days", remedies.choice],
  ["wrong days type", withChoice({ ...fixed(30), days: "30" }), "/allowedCadences/0/days", remedies.days],
  ["days too small", withChoice(fixed(0)), "/allowedCadences/0/days", remedies.days],
  ["days too large", withChoice(fixed(3661)), "/allowedCadences/0/days", remedies.days],
  ["fractional days", withChoice(fixed(1.5)), "/allowedCadences/0/days", remedies.days],
  ["missing months", withChoice({ schemaVersion: 1, kind: "calendar_months" }), "/allowedCadences/0/months", remedies.choice],
  ["wrong months type", withChoice({ ...calendar, months: "1" }), "/allowedCadences/0/months", remedies.days],
  ["months too small", withChoice({ ...calendar, months: 0 }), "/allowedCadences/0/months", remedies.days],
  ["fractional months", withChoice({ ...calendar, months: 1.5 }), "/allowedCadences/0/months", remedies.days],
  ["reserved calendar choice", { ...declaration, allowedCadences: [fixed(1), calendar] }, "/allowedCadences/1",
    'V1 accepts only "fixed_days" choices. Replace this choice with a fixed-day choice such as { schemaVersion: 1, kind: "fixed_days", days: 30 }.',
    "cadence_kind_unsupported"],

  ["wrong maxFixedDays type", { ...declaration, maxFixedDays: "120" }, "/maxFixedDays", remedies.maxFixedDays],
  ["maxFixedDays too small", { ...declaration, maxFixedDays: 0 }, "/maxFixedDays", remedies.maxFixedDays],
  ["maxFixedDays too large", { ...declaration, maxFixedDays: 3661 }, "/maxFixedDays", remedies.maxFixedDays],
  ["fractional maxFixedDays", { ...declaration, maxFixedDays: 1.5 }, "/maxFixedDays", remedies.maxFixedDays],

  ["missing policyRef", withPolicyRef(undefined), "/policyRef", remedies.policyRef],
  ["wrong policyRef type", withPolicyRef("example:policy"), "/policyRef", remedies.policyRef],
  ["empty policyRef", withPolicyRef({}), "/policyRef/key", remedies.policyKey],
  ["unknown policyRef key", withPolicyRef({ ...declaration.policyRef, "extra~/field": true }), "/policyRef/extra~0~1field", remedies.unexpected],
  ["missing policyRef key", withPolicyRef({ version: 1 }), "/policyRef/key", remedies.policyKey],
  ["wrong policyRef key type", withPolicyRef({ ...declaration.policyRef, key: 1 }), "/policyRef/key", remedies.policyKey],
  ["policyRef key too long", withPolicyRef({ ...declaration.policyRef, key: longKey }), "/policyRef/key", remedies.policyKey],
  ["invalid policyRef key format", withPolicyRef({ ...declaration.policyRef, key: "Policy" }), "/policyRef/key", remedies.policyKey],
  ["empty policyRef key", withPolicyRef({ ...declaration.policyRef, key: "" }), "/policyRef/key", remedies.policyKey],
  ["missing policyRef version", withPolicyRef({ key: "example:policy" }), "/policyRef/version", remedies.policyVersion],
  ["wrong policyRef version type", withPolicyRef({ ...declaration.policyRef, version: "1" }), "/policyRef/version", remedies.policyVersion],
  ["policyRef version too small", withPolicyRef({ ...declaration.policyRef, version: 0 }), "/policyRef/version", remedies.policyVersion],
  ["policyRef version too large", withPolicyRef({ ...declaration.policyRef, version: 2147483648 }), "/policyRef/version", remedies.policyVersion],
  ["fractional policyRef version", withPolicyRef({ ...declaration.policyRef, version: 1.5 }), "/policyRef/version", remedies.policyVersion],

  ["missing policyDigest", { ...declaration, policyDigest: undefined }, "/policyDigest", remedies.policyDigest],
  ["wrong policyDigest type", { ...declaration, policyDigest: 1 }, "/policyDigest", remedies.policyDigest],
  ["wrong policyDigest length", { ...declaration, policyDigest: "a".repeat(63) }, "/policyDigest", remedies.policyDigest],
  ["invalid policyDigest characters", { ...declaration, policyDigest: "A".repeat(64) }, "/policyDigest", remedies.policyDigest],
  ["empty policyDigest", { ...declaration, policyDigest: "" }, "/policyDigest", remedies.policyDigest],
])("returns the exact profile issue for %s", (_case, input, path, fix, code = "definition_profile_invalid") => {
  expect(validateCatalogSubscriptionProfile(input)).toEqual({ issue: { code, path, fix } });
});

it.each([
  ["policyDigest", { policyDigest: "abc" }, "Supply policyDigest as a 64-character lowercase SHA-256 hex digest."],
  ["policyRef/displayLabel", { policyRef: { ...declaration.policyRef, displayLabel: "example" } },
    'Remove the unexpected property "displayLabel".'],
  ["allowedCadences", { allowedCadences: fixed(30) },
    'Wrap the cadence choice in an array: allowedCadences: [{ schemaVersion: 1, kind: "fixed_days", days }].'],
  ["allowedCadences/0/schemaVersion", { allowedCadences: [{ ...fixed(30), schemaVersion: 2 }] },
    "Use schemaVersion 1 for this cadence choice."],
] as const)("preserves the remedy for an invalid %s from declaration to selector", (path, change, fix) => {
  const badDeclaration = { ...declaration, ...change } as unknown as CatalogSubscriptionProfileV1;
  const issue = { code: "definition_profile_invalid", path: `/${path}`, fix };
  expect(validateCatalogSubscriptionProfile(badDeclaration)).toEqual({ issue });
  expect(selectCatalogProfileCadence({ ...request(fixed(30)), profile: { declaration: badDeclaration, installed } }))
    .toEqual({ code: "policy_binding_missing", issue });
});
