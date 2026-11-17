import { expect, it, vi } from "vitest";
import { catalogDraftPriceOperationV2Schema } from "../../src/catalog/draftV2Schemas.js";
import { canonicalCatalogDraftJson } from "../../src/catalog/contracts/draft.js";
import { catalogPriceSetupCommandSchema, canonicalCatalogPriceSetupCommand } from "../../src/pricing/catalogPriceSetupSchemas.js";
import { catalogPriceSetupRefusal, CATALOG_PRICE_SETUP_HARD_REFUSALS, createPostgresCatalogPriceSetupStore } from "../../src/pricing/postgresCatalogPriceSetupStore.js";

const command = { schemaVersion: 1, commandKey: "example:price", variantId: "10000000-0000-4000-8000-000000000001",
  priceListId: "20000000-0000-4000-8000-000000000001", mode: "one_time", minQty: 1, amountKind: "gross",
  unitPriceMinor: 1200, expected: { entryId: null, unitPriceMinor: null } };

it("canonical_bytes_match_the_v2_and_v3_donor_price_DTO", () => {
  expect(canonicalCatalogPriceSetupCommand(command)).toBe(canonicalCatalogDraftJson(catalogDraftPriceOperationV2Schema.parse(command)));
  for (const delta of [{ mode: "any" }, { mode: "subscription" }, { minQty: 2 }, { amountKind: "net" }, { unitPriceMinor: 0 },
    { expectedContextVersion: 1 }, { validFrom: "2026-01-01T00:00:00Z" }]) {
    const input = { ...command, ...delta };
    expect(catalogDraftPriceOperationV2Schema.safeParse(input).success).toBe(false);
    expect(catalogPriceSetupCommandSchema.safeParse(input).success).toBe(false);
  }
});
it.each(CATALOG_PRICE_SETUP_HARD_REFUSALS)("hard_refusal_%s_is_explicit_and_fail_closed", reason => {
  expect(catalogPriceSetupRefusal({ code: "55000", message: `catalog_price_setup_${reason}` }))
    .toEqual({ outcome: "dependency_unavailable", reason });
});
it("refusal_precedence_never_exposes_unlisted_database_text", () => {
  expect(catalogPriceSetupRefusal({ code: "42501", message: "private" })).toEqual({ outcome: "unauthorized", reason: "operator_required" });
  expect(catalogPriceSetupRefusal({ code: "40001", message: "private" })).toEqual({ outcome: "conflict", reason: "expected_state_mismatch" });
  expect(catalogPriceSetupRefusal({ code: "55000", message: "catalog_price_setup_readiness_would_fail", detail: '["example_reason"]' }))
    .toEqual({ outcome: "validation_issue", reason: "readiness_would_fail", reasons: ["example_reason"] });
  expect(catalogPriceSetupRefusal({ code: "55000", message: "private", detail: "private" })).toEqual({ outcome: "dependency_unavailable", reason: "store_unavailable" });
});
it("native_store_uses_the_supplied_session_connection_and_validates_answers", async () => {
  const query = vi.fn().mockResolvedValue({ rows: [{ result: { outcome: "validation_issue", reason: "sku_not_found" } }] });
  const store = createPostgresCatalogPriceSetupStore({ query });
  expect(await store.apply({ canonicalCommand: "{}", fingerprint: "a".repeat(64) })).toEqual({ outcome: "validation_issue", reason: "sku_not_found" });
  expect(query).toHaveBeenCalledWith("SELECT public.catalog_price_setup_apply($1::text,$2::text) AS result", ["{}", "a".repeat(64)]);
  query.mockResolvedValueOnce({ rows: [{ result: { secret: true } }] });
  expect(await store.preview(command)).toEqual({ outcome: "dependency_unavailable", reason: "invalid_store_response" });
  query.mockRejectedValueOnce({ code: "55000", message: "catalog_price_setup_native_order_policy_pair_unverified" });
  expect(await store.apply({ canonicalCommand: "{}", fingerprint: "a".repeat(64) })).toEqual({ outcome: "dependency_unavailable", reason: "native_order_policy_pair_unverified" });
});
