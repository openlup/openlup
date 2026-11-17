import { expect, it } from "vitest";
import { acquisitionTermsMetadataSchema, createOfferPolicyReadinessCache } from "../../src/pricing/index.js";
import { CATALOG_MIGRATIONS } from "../../src/catalog/sql.js";

const metadata = { schemaVersion: "subscription-acquisition.v1", revision: "example:terms-1", delivery2DiscountBps: 3500 };
it.each([
  ["zero", { ...metadata, delivery2DiscountBps: 0 }, true],
  ["upper bound", { ...metadata, delivery2DiscountBps: 10000 }, true],
  ["missing", { revision: metadata.revision }, false], ["null", null, false],
  ["wrong type", { ...metadata, delivery2DiscountBps: "3500" }, false],
  ["fraction", { ...metadata, delivery2DiscountBps: 0.5 }, false],
  ["negative", { ...metadata, delivery2DiscountBps: -1 }, false],
  ["overflow", { ...metadata, delivery2DiscountBps: 10001 }, false],
  ["unknown field", { ...metadata, extra: true }, false],
  ["empty revision", { ...metadata, revision: "" }, false],
] as const)("native_readiness_metadata_golden_%s", (_label, value, valid) => {
  expect(acquisitionTermsMetadataSchema.safeParse(value).success).toBe(valid);
});

it.each(["settlement_context", "native_promotion_domain", "native_price_domain", "native_catalog_domain", "native_policy_domain",
  "native_agreement_domain", "native_cohort", "native_job_domain", "native_order_domain", "native_order_policy_pair",
  "native_order_admission", "native_order_guard", "native_order_claim_guard"])("native_readiness_hard_%s_failure_stays_fail_closed", async suffix => {
  const cache = createOfferPolicyReadinessCache({ negativeTtlMs: 0 });
  const result = await cache.read({ readOfferPolicyV2Readiness: async () => { throw new Error(`catalog_price_setup_${suffix}_unverified`); } });
  expect(result.ready).toBe(false);
  expect(result.reasons).toEqual(["readiness_rpc_unavailable"]);
});
it("native_readiness_descriptor_follows_the_draft_input_dependency", () => {
  const unit = CATALOG_MIGRATIONS.find(unit => unit.id === "20261122170000_offer_policy_readiness_inputs")!;
  expect(unit.id).toBe("20261122170000_offer_policy_readiness_inputs");
  expect(unit.position).toBe(CATALOG_MIGRATIONS.find(unit => unit.id === "20261122160000_catalog_drafts_v3")!.position + 1);
  expect(unit.sha256).toMatch(/^[a-f0-9]{64}$/u);
});
