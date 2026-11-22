import { validateCatalogSubscriptionProfile, type CatalogSubscriptionProfileV1 } from "@openlup/core/catalog";
import { parseCadenceChoiceV1, type CadenceChoiceV1 } from "@openlup/core/subscription";
import { describe, expect, it, vi } from "vitest";
import { catalogPackManifest } from "../../src/catalog/catalogPackManifest.js";
import { catalogSubscriptionProfileIdentity } from "../../src/catalog/installedSubscriptionProfiles.js";
import { createPostgresSubscriptionCommandStore, selectCatalogProfileCadence, type CatalogProfileCadenceInput } from "../../src/subscriptions/index.js";

const fixed = (days: number) => ({ schemaVersion: 1, kind: "fixed_days", days } as const);
const calendar = { schemaVersion: 1, kind: "calendar_months", months: 1 } as const;
const ref = { key: "example:repeat", version: 1 };
const declaration: CatalogSubscriptionProfileV1 = {
  ...ref, allowedCadences: [1, 30, 120, 121, 3660].map(fixed),
  policyRef: { key: "example:policy", version: 1 }, policyDigest: "a".repeat(64),
};
const installed = catalogSubscriptionProfileIdentity(declaration);
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
    expect(selectCatalogProfileCadence({ ...input, profile: { declaration: different, installed: catalogSubscriptionProfileIdentity(different) } }))
      .toEqual({ code: "cadence_not_offered" });
  });
});

describe("SP1-D-026 fixed-day bounds", () => {
  it("admits 1 and 3660, rejects 3661 and intersects an optional 120-day cap", () => {
    for (const days of [1, 3660]) expect(selectCatalogProfileCadence(request(fixed(days)))).toEqual({ cadenceDays: days });
    expect(selectCatalogProfileCadence(request(fixed(3661)))).toEqual({ code: "cadence_not_offered" });
    const capped = { ...declaration, maxFixedDays: 120 };
    const profile = { declaration: capped, installed: catalogSubscriptionProfileIdentity(capped) };
    expect(selectCatalogProfileCadence({ ...request(fixed(120)), profile })).toEqual({ cadenceDays: 120 });
    expect(selectCatalogProfileCadence({ ...request(fixed(121)), profile })).toEqual({ code: "cadence_not_offered" });
  });

  it("round-trips the reserved choice but refuses it at install and execution", () => {
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

it("canonicalizes a profile cadence set into the same manifest and profile digest", () => {
  const pack = { id: "example:pack", namespace: "example", version: 1, openlupRange: "1.x", capabilities: {},
    types: [], taxClasses: [], subscriptionProfiles: [ref] };
  const first = catalogPackManifest({ ...pack, subscriptionProfileDefinitions: [declaration] });
  const reordered = { policyDigest: declaration.policyDigest, policyRef: declaration.policyRef, ...ref,
    allowedCadences: [...declaration.allowedCadences].reverse() };
  expect(catalogPackManifest({ ...pack, subscriptionProfileDefinitions: [reordered] })).toEqual(first);
  expect(first.subscriptionProfileDefinitions?.[0].profileDigest).toBe(installed.profileDigest);
  expect(catalogPackManifest(pack)).not.toHaveProperty("subscriptionProfileDefinitions");
});
