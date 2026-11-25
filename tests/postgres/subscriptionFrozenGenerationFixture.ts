import { expect } from "vitest";

export const frozenGenerationSignature = "public.subscription_read_frozen_renewal_generation(uuid,uuid)";
export const frozenGenerationSql = "SELECT public.subscription_read_frozen_renewal_generation($1::uuid,$2::uuid)";
export const generationForward = "db/platform/migrations/20261129120000_subscription_renewal_generation_seam.sql";

const amountName = /(?:amount|minor|subtotal|total|fee|payable)|(?:price|tax|discount|shipping)(?:[._-]?(?:gross|net|value|rate|charge|cost|cents|bps|percent))?$/i;
const numericPaths = ["lines[].unitAmountMinor", "shippingTerms.flatMinor", "shippingTerms.freeThresholdMinor"];
const binding = "lineKey? skuId skuCode mode role source skuRevisionId?";
const keys: Record<string, string> = {
  "": "operationId commercialGenerationId subscriptionId scheduledAt cycleNumber logicalCycle clientId template operationFingerprint lines currency catalogAcceptance linePricing discountTerms shippingTerms shippingAddressRef stockSourceKey settlementChannelKey authorizationRef payerAccountRef unattendedChargeAuthorizedAt",
  logicalCycle: "activationCycleId evidenceRef",
  template: "id",
  "lines[]": "sku unitAmountMinor",
  catalogAcceptance: "lines admission?",
  "catalogAcceptance.lines[]": "skuId skuCode skuRevisionId publicationHead typeRef definitionDigest optionDigest netContent demandPolicyRef?",
  "catalogAcceptance.lines[].publicationHead": "publicationId documentDigest",
  "catalogAcceptance.lines[].typeRef": "key",
  "catalogAcceptance.lines[].netContent": "dimension unscaled unit",
  "catalogAcceptance.admission": "quoteRef? quoteDigest moneyVersion priceEvidenceRef policyEvidenceRef acceptanceTokenDigest? consultedHeads offer? lineBindings legacyReviewEvidence? destinationRef? destinationDigest? graduation?",
  "catalogAcceptance.admission.consultedHeads[]": "productId publicationId documentDigest",
  "catalogAcceptance.admission.offer": "ref version",
  "catalogAcceptance.admission.lineBindings[]": binding,
  "catalogAcceptance.admission.legacyReviewEvidence": "identityComparison priceEvidenceRef policyEvidenceRef priorPriceEvidenceRef? priorPolicyEvidenceRef?",
  "catalogAcceptance.admission.graduation": "phaseDigest lineBindings",
  "catalogAcceptance.admission.graduation.lineBindings[]": binding,
  "linePricing[]": "sku quoteLine",
  "linePricing[].quoteLine": "catalogFacts",
  "linePricing[].quoteLine.catalogFacts": "provenance basePriceEntryId? basePriceListId? resolvedPriceEntryId? policyRevisionId? policyDigest? documentRevisionId? documentDigest? skuId? mode? currency? atTime?",
  discountTerms: "reasonCode acquisitionRef?",
  shippingTerms: "version currency flatMinor freeThresholdMinor",
};
const arrayPaths = ["lines", "linePricing", "catalogAcceptance.lines", "catalogAcceptance.admission.consultedHeads",
  "catalogAcceptance.admission.lineBindings", "catalogAcceptance.admission.graduation.lineBindings"];

export function expectFrozenGenerationShape(projection: unknown) {
  const numbers = new Set<string>();
  function walk(node: unknown, path: string) {
    if (node === null) return;
    if (arrayPaths.includes(path)) {
      expect(Array.isArray(node), path).toBe(true);
      for (const entry of node as unknown[]) walk(entry, `${path}[]`);
    } else if (keys[path] !== undefined) {
      expect(node && typeof node === "object" && !Array.isArray(node), path).toBe(true);
      const schema = keys[path].split(" ");
      const actual = Object.keys(node as object);
      expect(actual.filter(key => !schema.includes(key) && !schema.includes(`${key}?`)), path).toEqual([]);
      expect(actual, path).toEqual(expect.arrayContaining(schema.filter(key => !key.endsWith("?"))));
      for (const [key, value] of Object.entries(node as object)) {
        const child = path ? `${path}.${key}` : key;
        if (amountName.test(key)) expect(numericPaths, child).toContain(child);
        walk(value, child);
      }
    } else if (numericPaths.includes(path)) {
      expect(typeof node, path).toBe("number");
      numbers.add(path);
    } else {
      expect(typeof node, path).toBe("string");
    }
  }
  walk(projection, "");
  return [...numbers].sort();
}

/** Seed excluded fields at every actual object boundary of a private fixture. */
export function plantExcludedFrozenFields(node: unknown, path: string[] = []): void {
  if (Array.isArray(node)) {
    node.forEach((member, index) => plantExcludedFrozenFields(member, [...path, String(index)]));
  } else if (node && typeof node === "object") {
    const object = node as Record<string, unknown>;
    for (const [key, value] of Object.entries(object)) plantExcludedFrozenFields(value, [...path, key]);
    object.excluded = { payload: [{ Total: "opaque", subtotal: 18 }] };
    object["tax-net"] = "18";
    object.PayableValue = 19;
    if (path.join(".") !== "pricingSnapshot.shippingTerms") {
      object.flatMinor = 301;
      object.freeThresholdMinor = 302;
    }
  }
}
