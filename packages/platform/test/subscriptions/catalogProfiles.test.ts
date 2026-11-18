import { describe, expect, it, vi } from "vitest";
import type { CatalogQuantity } from "@openlup/core/catalog";
import { defineCatalogPack } from "../../src/catalog/contracts/catalogPack.js";
import { hasInstalledSubscriptionProfile } from "../../src/catalog/installedSubscriptionProfiles.js";
import { catalogPackIssues } from "../../src/catalog/productTypeIssues.js";
import { catalogPackManifest } from "../../src/catalog/catalogPackManifest.js";
import { createCatalogSubscriptionProfileBinding, type CatalogProfileLine } from "../../src/subscriptions/catalogProfileBinding.js";
import { CATALOG_SUBSCRIPTION_PROFILE_MAX_CADENCE_DAYS, validateCatalogSubscriptionProfile,
  type CatalogSubscriptionProfileV1 } from "@openlup/core/catalog";

const typeRef = { key: "store:item", version: 1 };
const policyRef = { key: "store:exact", version: 1, digest: "a".repeat(64) };
const policy = { ref: policyRef, kind: "units_per_day", coverage: "exact" } as const;
const group = "store:substitution";
const definition: CatalogSubscriptionProfileV1 = {
  key: "store:recurring", version: 1, allowedCadenceDays: [28, 30],
  quantities: { minBaseUnits: 1, maxBaseUnits: 5, maxBaseLines: 3, maxUnitsPerLine: 4 },
  swapGroupKeys: [group], addons: { maxLines: 1, maxUnits: 2, allowedTypeRefs: [{ key: "store:extra", version: 1 }] },
  consumption: { kind: "fixed_units" }, prepaid: "unsupported",
};
const profileRef = { key: definition.key, version: definition.version };
const point = { publicationId: "publication", revision: 1, documentDigest: "d".repeat(64) };
const count = (unscaled: string): CatalogQuantity => ({ dimension: "count", unit: "openlup:piece", unscaled, scale: 0 });
const mass = (unscaled: string): CatalogQuantity => ({ dimension: "mass", unit: "openlup:g", unscaled, scale: 0 });

function fixture(profile: CatalogSubscriptionProfileV1 = definition, policies: Parameters<typeof createCatalogSubscriptionProfileBinding>[0]["policies"] = []) {
  const binding = createCatalogSubscriptionProfileBinding({ profiles: [profile], policies });
  const line = (id: string, overrides: Partial<CatalogProfileLine> = {}): CatalogProfileLine => ({
    id, quantity: 1, typeRef, addon: false, sellable: true,
    profileRef, profileDigest: binding.resolve(profileRef)!.digest, ...overrides,
  });
  const base = line("a");
  const addon = line("extra", { addon: true, typeRef: { key: "store:extra", version: 1 }, profileRef: undefined, profileDigest: undefined });
  return { binding, line, base, addon, selection: { cadenceDays: 28, lineItems: [base] } };
}
const liveLine = (line: CatalogProfileLine): CatalogProfileLine => ({ ...line, publication: {
  productId: "product", documentRevisionId: "document", reference: { schemaVersion: 2, skuId: line.id, skuCode: line.id,
    skuRevisionId: "sku-revision", publicationHead: point, typeRef, definitionDigest: "b".repeat(64),
    optionDigest: "c".repeat(64), netContent: count("56") },
} });

describe("profile_dispatch_matrix", () => {
  it.each([
    ["SP1-D-001 legacy no policy read", undefined, "legacy", 0],
    ["SP1-D-002 unknown profile", { key: "store:unknown", version: 1 }, "profile_missing", 0],
    ["SP1-D-002 explicitly selected", profileRef, "profiled", 1],
  ] as const)("%s", (_witness, ref, expected, reads) => {
    const validate = vi.fn(() => undefined);
    const { binding, base, selection } = fixture({ ...definition, consumption: {
      kind: "host_policy", policyRef, demandScope: { kind: "per_line" },
    } }, [{ ref: policyRef, kind: "host_policy", validate }]);
    const result = binding.check({ ...selection, lineItems: [{ ...base, profileRef: ref }] });
    expect(result.kind === "refused" ? result.issue.code : result.kind).toBe(expected);
    expect(validate).toHaveBeenCalledTimes(reads);
  });
});

describe("profile_admission_matrix", () => {
  const { binding, line, base, addon, selection } = fixture();
  it.each([
    ["SP1-D-006 profile_cannot_broaden_sku_sellability", { lineItems: [line("a", { sellable: false })] }, "profile_line_not_sellable"],
    ["SP1-D-024 profile_refuses_cadence_outside_intersection profile", { cadenceDays: 29 }, "cadence_not_allowed"],
    ["SP1-D-024 store", { storeCadenceDays: [30] }, "cadence_not_allowed"],
    ["SP1-D-024 SKU", { lineItems: [line("a", { allowedCadenceDays: [30] })] }, "cadence_not_allowed"],
    ["SP1-D-024 command", { commandCadenceDays: [30] }, "cadence_not_allowed"],
    ["SP1-D-024 no common day", { lineItems: [line("a", { allowedCadenceDays: [28] }), line("b", { allowedCadenceDays: [30] })] }, "cadence_not_allowed"],
    ["SP1-D-024 per-line quantity", { lineItems: [line("a", { quantity: 5 })] }, "profile_line_quantity_invalid"],
    ["SP1-D-024 positive quantity", { lineItems: [line("a", { quantity: 0 })] }, "profile_line_quantity_invalid"],
    ["SP1-D-024 integral quantity", { lineItems: [line("a", { quantity: 1.2 })] }, "profile_line_quantity_invalid"],
    ["SP1-D-024 max base", { lineItems: [line("a", { quantity: 3 }), line("b", { quantity: 3 })] }, "profile_base_units_out_of_range"],
    ["SP1-D-024 max base lines", { lineItems: [base, line("b"), line("c"), line("d")] }, "profile_base_line_limit_exceeded"],
    ["SP1-D-024 add-on type", { lineItems: [base, { ...addon, typeRef }] }, "profile_addon_type_not_allowed"],
    ["SP1-D-024 add-on units", { lineItems: [base, { ...addon, quantity: 3 }] }, "profile_addon_unit_limit_exceeded"],
    ["SP1-D-024 add-on lines", { lineItems: [base, addon, { ...addon, id: "more" }] }, "profile_addon_line_limit_exceeded"],
    ["SP1-D-027 profile_prepaid_declared_unsupported", { prepaid: true }, "prepaid_unsupported"],
  ] as const)("%s", (_witness, change, code) => {
    expect(binding.check({ ...selection, ...change })).toMatchObject({ kind: "refused", issue: { code } });
  });

  it.each([
    ["SP1-D-024 min base", { quantities: { ...definition.quantities, minBaseUnits: 2 } }, "profile_base_units_out_of_range"],
    ["SP1-D-024 zero add-on lines", { addons: { ...definition.addons, maxLines: 0 } }, "profile_addon_line_limit_exceeded"],
    ["SP1-D-024 zero add-on units", { addons: { ...definition.addons, maxUnits: 0 } }, "profile_addon_unit_limit_exceeded"],
  ] as const)("%s", (_witness, change, code) => {
    const custom = fixture({ ...definition, ...change });
    expect(custom.binding.check({ cadenceDays: 28, lineItems: [custom.base, custom.addon] })).toMatchObject({ issue: { code } });
  });

  const original = line("old", { quantity: 2, swapGroupKey: group, capacity: count("56") });
  it.each([
    ["SP1-D-027 profile_swap_preserves_quantity_or_refuses_capacity_change", {}, "profiled"],
    ["SP1-D-027 quantity", { quantity: 1 }, "profile_swap_capacity_mismatch"],
    ["SP1-D-027 capacity", { capacity: count("60") }, "profile_swap_capacity_mismatch"],
    ["SP1-D-027 group", { swapGroupKey: "store:other" }, "profile_swap_group_mismatch"],
  ] as const)("%s", (_witness, change, expected) => {
    const result = binding.check({ cadenceDays: 28, lineItems: [{ ...original, id: "new", ...change }],
      swap: { from: original, to: "new" } });
    expect(result.kind === "refused" ? result.issue.code : result.kind).toBe(expected);
  });
});

describe("profile_attachment_continuity_matrix", () => {
  const { binding, base, selection } = fixture();
  it.each([
    ["SP1-D-023 duplicate line", [base, base], "profile_attachment_invalid"],
    ["SP1-D-023 cross-wired publication", [liveLine({ ...base, id: "other" }), { ...liveLine(base), id: "wrong" }], "profile_attachment_invalid"],
    ["SP1-D-023 missing digest", [{ ...base, profileDigest: undefined }], "policy_binding_missing"],
    ["SP1-D-023 stale digest", [{ ...base, profileDigest: "f".repeat(64) }], "policy_binding_missing"],
    ["SP1-D-023 partial attachment", [liveLine(base), { ...base, id: "other" }], "profile_attachment_invalid"],
  ] as const)("%s", (_witness, lineItems, code) => {
    expect(binding.check({ ...selection, lineItems })).toMatchObject({ kind: "refused", issue: { code } });
  });

  it("SP1-D-022 full profile declarations compose alongside reference-only type metadata", () => {
    const authored = defineCatalogPack({
      id: "store:pack", namespace: "store", version: 1, openlupRange: "1.x", capabilities: {}, taxClasses: [],
      subscriptionProfiles: [{ key: "store:recurring", version: 1 }], subscriptionProfileDefinitions: [definition],
      types: [{ key: "store:item", version: 1, dimensions: [], units: [{ code: "openlup:piece", dimension: "count", integral: true }],
        netContentUnits: ["openlup:piece"], subscriptionProfileRef: { key: "store:recurring", version: 1 }, validateContent: () => [] }],
    });
    expect(catalogPackIssues(authored)).toEqual([]);
    expect(catalogPackManifest(authored).subscriptionProfileDefinitions).toEqual([definition]);
  });

  it("SP1-D-022 legacy_subscription_without_profile_is_unchanged", () => {
    expect(binding.check({ cadenceDays: 500, lineItems: [{ ...base, profileRef: undefined, quantity: 0 }] })).toEqual({ kind: "legacy" });
  });

  it.each([
    ["equal", definition, base.profileDigest!, true, 1],
    ["different digest", definition, "e".repeat(64), false, 0],
    ["different version", { ...definition, version: 2 }, base.profileDigest!, false, 1],
  ] as const)("SP1-D-023 installed binding (%s)", async (_case, installed, digest, expected, queries) => {
    const query = vi.fn(async () => ({ rows: [{ profile: installed }] }));
    expect(await hasInstalledSubscriptionProfile({ query }, profileRef, { profile: definition, digest })).toBe(expected);
    expect(query).toHaveBeenCalledTimes(queries);
  });

  it("SP1-D-022 exact older definition retained when a higher version is introduced", () => {
    const v2 = { ...definition, version: 2, allowedCadenceDays: [30] };
    const next = createCatalogSubscriptionProfileBinding({ profiles: [definition, v2] });
    expect(next.resolve(profileRef)?.digest).toBe(binding.resolve(profileRef)?.digest);
    expect(next.resolve({ key: definition.key, version: 2 })?.digest).not.toBe(base.profileDigest);
    expect(next.check({ ...selection, lineItems: [liveLine(base)] })).toMatchObject({
      kind: "profiled", attachments: [{ variantId: "a", profileRef, profileDigest: base.profileDigest,
        publicationHead: point, productId: "product", documentRevisionId: "document", documentDigest: point.documentDigest }],
    });
  });

  it.each(["missing", "different build"] as const)("SP1-D-023 profile_missing_binding_refuses_before_write (%s)", mismatch => {
    const { binding: unbound, selection: input } = fixture({ ...definition, consumption: {
      kind: "units_per_day", demandUnit: "per_line", policyRef, demandScope: { kind: "per_line" },
    } }, mismatch === "missing" ? [] : [{ ...policy, ref: { ...policyRef, digest: "b".repeat(64) } }]);
    expect(unbound.check(input)).toMatchObject({ issue: { code: "policy_binding_missing" } });
  });
});

describe("profile_demand_matrix", () => {
  const consumption = { kind: "units_per_day", demandUnit: "per_line", policyRef, demandScope: { kind: "per_line" } } as const;
  const { binding, line } = fixture({ ...definition, consumption }, [policy]);
  const first = line("a", { demand: { contentPerUnit: count("56"), perDay: count("2") } });
  const second = line("b", { demand: { contentPerUnit: mass("140"), perDay: mass("5") } });
  it.each(["purchase", "edit", "renewal", "checker"])("SP1-D-025 mixed_count_mass_subscription_purchase_edit_renew (%s owner input)", () => {
    expect(binding.check({ cadenceDays: 28, lineItems: [first, second] })).toMatchObject({
      kind: "profiled", proposalDays: 28,
      coverage: [{ lineIds: ["a"], exact: true, wholeDays: 28 }, { lineIds: ["b"], exact: true, wholeDays: 28 }],
    });
  });
  it.each([
    ["SP1-D-025 per_line_resize_never_transfers_units_across_products", [
      { ...first, demand: { ...first.demand!, contentPerUnit: count("55") } },
      { ...second, demand: { ...second.demand!, contentPerUnit: mass("141") } },
    ], "line_coverage_mismatch"],
    ["SP1-D-025 profile_refuses_incompatible_demand_units", [{ ...first, demand: { ...first.demand!, perDay: mass("2") } }], "demand_unit_mismatch"],
    ["SP1-D-025 isolated coverage mismatch", [first, { ...second, demand: { ...second.demand!, perDay: mass("4") } }], "line_coverage_mismatch"],
    ["SP1-D-011 malformed decimal scale", [{ ...first, demand: { ...first.demand!, perDay: { ...count("2"), scale: -1 } } }], "demand_arithmetic_unsafe"],
    ["SP1-D-011 single input overflow", [{ ...first, demand: { ...first.demand!, contentPerUnit: count("9007199254740992") } }], "demand_arithmetic_unsafe"],
    ["SP1-D-011 multiplication overflow", [{ ...first, quantity: 2, demand: { ...first.demand!, contentPerUnit: count("9007199254740991") } }], "demand_arithmetic_unsafe"],
    ["SP1-D-025 fractional duration", [{ ...first, demand: { ...first.demand!, contentPerUnit: count("57") } }], "line_coverage_mismatch"],
  ] as const)("%s", (_witness, lineItems, code) => {
    expect(binding.check({ cadenceDays: 28, lineItems })).toMatchObject({ kind: "refused", issue: { code } });
  });

  it("SP1-D-025 per_line_units_checked_within_pool_only", () => {
    const pooled = fixture({ ...definition, consumption: { ...consumption, demandUnit: "openlup:piece",
      demandScope: { kind: "pooled", poolKey: "store:pool" } } }, [policy]);
    const a = pooled.line("a", { demand: { contentPerUnit: count("30"), perDay: count("2") } });
    const b = pooled.line("b", { demand: { contentPerUnit: count("26"), perDay: count("2") } });
    expect(pooled.binding.check({ cadenceDays: 28, lineItems: [a, b] })).toMatchObject({
      coverage: [{ lineIds: ["a", "b"], wholeDays: 28, exact: true }],
    });
    expect(pooled.binding.check({ cadenceDays: 28, lineItems: [a, { ...b, demand: second.demand }] })).toMatchObject({
      issue: { code: "demand_unit_mismatch" },
    });
  });

  it.each([true, false])("SP1-D-025 supplements_60_at_2_proposes_allowed_30_days (allowed=%s)", allowed => {
    const surplus = fixture({ ...definition, consumption }, [{ ...policy, coverage: "allow_surplus" }]);
    const result = surplus.binding.check({ cadenceDays: 28, storeCadenceDays: allowed ? [28, 30] : [28],
      lineItems: [surplus.line("a", { demand: { contentPerUnit: count("60"), perDay: count("2") } })] });
    expect(result).toMatchObject({ kind: "profiled", coverage: [{ wholeDays: 30 }] });
    expect("proposalDays" in result ? result.proposalDays : undefined).toBe(allowed ? 30 : undefined);
  });
});

describe("cadence_bound_parity_matrix", () => {
  it.each([[90, true], [91, true], [120, true], [121, false]])("SP1-D-026 package bound for %i days", (day, valid) => {
    const evidence = validateCatalogSubscriptionProfile({ ...definition, allowedCadenceDays: [day] });
    expect("profile" in evidence).toBe(valid);
    if (!valid) expect(evidence).toEqual({ issue: { code: "profile_cadence_exceeds_platform_bound", path: "/allowedCadenceDays/0" } });
  });
  it("SP1-D-026 readiness_refuses_profile_above_installed_edit_bound", () => {
    const { binding, selection } = fixture({ ...definition, allowedCadenceDays: [90, 91, CATALOG_SUBSCRIPTION_PROFILE_MAX_CADENCE_DAYS] });
    expect(binding.check({ ...selection, cadenceDays: 91, installedCadenceBound: 90 })).toMatchObject({
      kind: "refused", issue: { code: "profile_cadence_bound_unavailable" },
    });
    expect(binding.check({ ...selection, cadenceDays: 91, installedCadenceBound: 3660 })).toMatchObject({
      kind: "profiled", allowedDays: [90, 91, 120],
    });
  });
  it("SP1-D-026 profile_cadence_exceeds_platform_bound_refuses through the offline owner", () => {
    const pack = { id: "store:test", namespace: "store", version: 1, openlupRange: "1.x", capabilities: {}, types: [], taxClasses: [],
      subscriptionProfiles: [profileRef], subscriptionProfileDefinitions: [{ ...definition, allowedCadenceDays: [121] }] };
    expect(catalogPackIssues(pack)).toEqual([{ code: "profile_cadence_exceeds_platform_bound",
      path: "/subscriptionProfileDefinitions/0/allowedCadenceDays/0" }]);
    expect(() => catalogPackManifest(pack)).toThrow("profile_cadence_exceeds_platform_bound");
    const validPack = { ...pack, subscriptionProfileDefinitions: [definition] };
    expect(catalogPackManifest(validPack).digest).not.toBe(catalogPackManifest({
      ...validPack, subscriptionProfileDefinitions: [{ ...definition, allowedCadenceDays: [28] }],
    }).digest);
  });
});
