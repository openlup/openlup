import { createHash, randomUUID } from "node:crypto";
import { expect, it, vi } from "vitest";
import { createManagedCatalogPublicationEvidence } from "./catalogPublicationEvidence.js";

const event = randomUUID(), product = randomUUID(), sku = randomUUID();
const text = '{"products":[],"skus":[]}';
const digest = createHash("sha256").update(text).digest("hex");
const prior = { event_id: event, event_sequence: 1, state_digest: digest, state_canonical_text: text };
const head = { ...prior, protocol: "v3" };
const identity = { skuId: sku, skuCode: "EXAMPLE-1", productId: product, productSlug: "article",
  netWeightG: 100, sellableStandalone: true, sellableInSubscription: true };
const member = { ...identity, presentation: null, logisticsRef: null };
const page = { protocol: "v3", headDigest: digest, items: [member], nextCursor: null };
const query = { offerVersion: "offer:existing", cursor: null, limit: 10, mode: "subscription" as const };
const ok = (data: unknown) => ({ data, error: null });
const missing = { data: null, error: { code: "PGRST202",
  message: "Could not find the function public.catalog_offer_memberships_page(p_cursor, p_limit, p_mode, p_offer_version) in the schema cache" } };
const fault = { data: null, error: { code: "42501", message: "permission denied for function" } };

it.each([
  ["LC8-D-002 no head row", ok(page), ok([]), "response_invalid"],
  ["LC8-D-002 two head rows", ok(page), ok([head, head]), "response_invalid"],
  ["LC8-D-002 current head without digest", ok(page), ok([{ ...head, state_digest: null }]), "response_invalid"],
  ["LC8-D-002 current head corrupt seal", ok(page), ok([{ ...head, state_canonical_text: "{}" }]), "response_invalid"],
  ["LC8-D-017 head moves", ok({ ...page, headDigest: "a".repeat(64) }), ok([head]), "authority_changed"],
  ["LC8-D-028 ambiguous prior", missing, ok([prior, prior]), "response_invalid"],
  ["LC8-D-028 unexpected prior wire discriminator", missing, ok([{ ...prior, protocol: "v2" }]), "response_invalid"],
  ["LC8-D-028 prior response without an event", missing, ok([{ ...prior, event_id: null }]), "response_invalid"],
  ["LC8-D-028 no downgrade for permission", fault, ok([prior]), "store_unavailable"],
])("catalog_native_managed_contract_conformance %s", async (_rule, first, second, reason) => {
  const rpc = vi.fn().mockResolvedValueOnce(first).mockResolvedValueOnce(second);
  const observe = createManagedCatalogPublicationEvidence({ client: { rpc }, validateState: () => true,
    expectedMembers: async () => [identity] });
  expect(await observe(query)).toEqual({ outcome: "refused", reason });
  if (first === fault) expect(rpc).toHaveBeenCalledTimes(1);
});

it.each([
  ["LC8-D-015 missing membership", [], [identity], "refused"],
  ["LC8-D-015 wrong membership identity", [{ ...member, productId: randomUUID() }], [identity], "refused"],
  ["LC8-D-015 exact membership", [member], [identity], "verified"],
  ["LC8-D-024 authoritative empty scope", [], [], "verified"],
] as const)("catalog_native_managed_contract_conformance %s", async (_rule, items, expected, outcome) => {
  const rpc = vi.fn().mockResolvedValueOnce(ok({ ...page, items })).mockResolvedValueOnce(ok([head]));
  const observe = createManagedCatalogPublicationEvidence({ client: { rpc }, validateState: async () => true,
    expectedMembers: async () => [...expected] });
  expect(await observe(query)).toMatchObject(outcome === "verified" ? { outcome, items } : { outcome, reason: "compatibility_identity_mismatch" });
});

it.each([
  ["pre-migration transport", missing, prior, "catalog_publication_v2_current_state"],
  ["current transport", ok({ ...page, protocol: "v2", items: [] }), { ...prior, protocol: "v2" }, "catalog_publication_v3_current_state"],
] as const)("catalog_native_managed_contract_conformance LC8-D-028 recognizes a sealed prior head without membership on %s", async (_lane, first, row, rpcName) => {
  const rpc = vi.fn().mockResolvedValueOnce(first).mockResolvedValueOnce(ok([row]));
  const expectedMembers = vi.fn();
  const observe = createManagedCatalogPublicationEvidence({ client: { rpc }, validateState: async () => true, expectedMembers });
  expect(await observe(query)).toMatchObject({ outcome: "prior_protocol", head: { protocol: "v2", headDigest: digest } });
  expect(rpc).toHaveBeenLastCalledWith(rpcName, {});
  expect(expectedMembers).not.toHaveBeenCalled();
});

it.each([
  ["LC8-D-003 zero codes", [], digest, null, "query_invalid"],
  ["LC8-D-003 duplicate codes", ["A", "A"], digest, null, "query_invalid"],
  ["LC8-D-003 cap", Array.from({ length: 101 }, (_, i) => String(i)), digest, null, "query_invalid"],
  ["LC8-D-003 invalid digest", ["A"], "bad", null, "query_invalid"],
  ["LC8-D-003 wrong head", [], digest, { headDigest: "a".repeat(64) }, "authority_changed"],
  ["LC8-D-003 wrong count", [], digest, { items: [] }, "authority_changed"],
  ["LC8-D-003 wrong order", [], digest, { reversed: true }, "authority_changed"],
  ["LC8-D-003 missing ready identity", [], digest, { skuId: null }, "response_invalid"],
  ["LC8-D-003 missing ready reference", [], digest, { logisticsRef: null }, "response_invalid"],
  ["LC8-D-003 readiness and reasons disagree", [], digest, { reasons: ["not_ready"] }, "response_invalid"],
] as const)("catalog_capabilities_and_writer_disable %s", async (_rule, codes, expected, variant, reason) => {
  const identities = ["A", "B"];
  const items = identities.map(skuCode => ({ skuCode, skuId: sku, ready: true, logisticsRef: "physical:reference", reasons: [] }));
  if (variant && "reversed" in variant) items.reverse();
  const data = { protocol: "v3", headDigest: digest, items,
    ...(variant && "headDigest" in variant ? { headDigest: variant.headDigest } : {}),
    ...(variant && "items" in variant ? { items: variant.items } : {}),
    ...(variant && ("skuId" in variant || "logisticsRef" in variant || "reasons" in variant) ? { items: [{ ...items[0], ...variant }, items[1]] } : {}),
  };
  const rpc = vi.fn().mockResolvedValue(ok(data));
  const port = createManagedCatalogPublicationEvidence({ client: { rpc }, validateState: () => true, expectedMembers: async () => [] });
  expect(await port.activationReadiness(variant === null ? codes : identities, expected)).toEqual({ outcome: "refused", reason });
  expect(rpc).toHaveBeenCalledTimes(variant === null ? 0 : 1);
});

it("catalog_capabilities_and_writer_disable LC8-D-003 admits ordered exact readiness", async () => {
  const items = [
    { skuCode: "AAA", skuId: sku, logisticsRef: "physical:reference", ready: true, reasons: [] },
    { skuCode: "BBB", skuId: null, logisticsRef: null, ready: false, reasons: ["sku_not_materialized"] },
  ];
  const rpc = vi.fn().mockResolvedValue(ok({ protocol: "v3", headDigest: digest, items }));
  const port = createManagedCatalogPublicationEvidence({ client: { rpc }, validateState: () => true, expectedMembers: async () => [] });
  expect(await port.activationReadiness(["AAA", "BBB"], digest)).toEqual({ outcome: "verified", headDigest: digest, items });
  expect(rpc).toHaveBeenCalledExactlyOnceWith("catalog_publication_v3_activation_readiness", {
    p_sku_codes: ["AAA", "BBB"], p_expected_head_digest: digest,
  });
});
