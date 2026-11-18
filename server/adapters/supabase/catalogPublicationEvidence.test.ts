import { createHash, randomUUID } from "node:crypto";
import { expect, it, vi } from "vitest";
import { createManagedCatalogPublicationEvidence } from "./catalogPublicationEvidence.js";

const event = randomUUID(), product = randomUUID(), sku = randomUUID();
const text = '{"products":[],"skus":[]}';
const digest = createHash("sha256").update(text).digest("hex");
const prior = { protocol: "v2", event_id: event, event_sequence: 1, state_digest: digest, state_canonical_text: text };
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

it("catalog_native_managed_contract_conformance LC8-D-028 recognizes a sealed prior head without membership", async () => {
  const rpc = vi.fn().mockResolvedValueOnce(missing).mockResolvedValueOnce(ok([prior]));
  const expectedMembers = vi.fn();
  const observe = createManagedCatalogPublicationEvidence({ client: { rpc }, validateState: async () => true, expectedMembers });
  expect(await observe(query)).toMatchObject({ outcome: "prior_protocol", head: { protocol: "v2", headDigest: digest } });
  expect(rpc).toHaveBeenLastCalledWith("catalog_publication_v2_current_state", {});
  expect(expectedMembers).not.toHaveBeenCalled();
});
