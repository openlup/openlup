import { randomUUID } from "node:crypto";
import type { Pool, PoolClient } from "pg";
import { resolveThresholdShipping } from "@openlup/platform/shipping";
import { canonicalCatalogDraftJson } from "@openlup/platform/catalog/contracts";
import { expect } from "vitest";
// eslint-disable-next-line no-restricted-imports -- use the installed private evaluator on the fixture writer
import { evaluateSelectedAdmissionOwner, ownerRequest, selectedInstant, type SelectedProfile } from "../../packages/platform/dist/catalog/catalogSelectedAdmissionOwner.js";
// eslint-disable-next-line no-restricted-imports -- assemble the exact SQL owner handoff
import { selectedWrite, type SelectedOriginal } from "../../packages/platform/dist/catalog/catalogSelectedAdmissionWrite.js";
// eslint-disable-next-line no-restricted-imports -- use the installed PostgreSQL price reader
import { createPostgresCommercePriceAuthorityReadPort } from "../../packages/platform/dist/commerce/server/postgres/commercePriceRead.js";
import { documentRow, fixture, graph, hash, insertGraph, installPublicationActors, transaction } from "./catalogPublicationFixture.js";

export const governedCore = "public.catalog_admission_write_governed_draft(text,uuid,jsonb)";
export const runtimeSql = "SELECT public.catalog_admission_runtime_checkout($1::text,$2::text,$3::uuid,$4::jsonb) AS result";
export const ownerSql = "SELECT public.catalog_admission_write_governed_draft($1::text,$2::uuid,$3::jsonb) AS result";
export const productPromotion = "example:product";
export const shippingPromotion = "example:shipping";
const currency = "XTS";
const offer = { ref: "owner:regular", version: "example:subscription" };

export async function seedGovernedDraft(owner: Pool, options: { product?: number; shipping?: number } = {}) {
  await installPublicationActors(owner);
  const actorRef = randomUUID(), email = "buyer@example.invalid";
  const clientId = (await owner.query("INSERT INTO public.clients(email,principal_id) VALUES($1,$2) RETURNING id", [email, actorRef])).rows[0]!.id;
  const seeded = await transaction(owner, async db => {
    const issued = await graph(db, { ...fixture(), skuCode: "ARTICLE-A" }, null, true, { lifecycle: "active", subscriptionEligible: true });
    issued.facts.memberships = [{ offerVersion: offer.version, admitted: true }];
    issued.facts.identifiers = [{ scheme: "gs1:gtin", issuer: "example", value: "0000000000017", packagingLevel: "unit", quantity: 1, isPrimary: true, label: null, sourceRef: null }];
    await insertGraph(db, issued);
    const legacy = await graph(db, { ...fixture(), skuCode: "ARTICLE-B" });
    await documentRow(db, legacy);
    await db.query("UPDATE public.catalog_products SET status='active' WHERE id=$1", [legacy.productId]);
    await db.query("UPDATE public.catalog_skus SET status='active',sellable_standalone=true,sellable_in_subscription=true WHERE id=$1", [legacy.skuId]);
    await db.query(`INSERT INTO public.catalog_sku_identifiers(catalog_sku_id,issuer,identifier_kind,normalized_value,pack_kind,quantity,is_primary)
      VALUES($1,'example','gtin','00000000000024','unit',1,true)`, [legacy.skuId]);
    return { issued, legacy };
  });
  const skuIds = [seeded.issued.skuId, seeded.legacy.skuId] as const;
  const priceListId = (await owner.query(`INSERT INTO public.price_lists(name,region_code,currency,status,valid_from)
    VALUES('Selected prices','ZZ',$1,'active',clock_timestamp()-interval '1 day') RETURNING id`, [currency])).rows[0]!.id;
  await owner.query(`INSERT INTO public.price_entries(price_list_id,variant_id,mode,min_qty,unit_price_minor,amount_kind,valid_from)
    SELECT $1,sku,mode,1,amount,'gross',clock_timestamp()-interval '1 day'
    FROM unnest($2::uuid[]) sku CROSS JOIN (VALUES ('one_time',1490),('subscription',1340)) tier(mode,amount)`, [priceListId, skuIds]);
  const validFrom = await sampleDraftTime(owner);
  const discounts = [
    ...(options.product ? [{ promotionId: productPromotion, appliesTo: "order_total" as const, amountOffMinor: options.product, reasonCode: "promotion_fixed_amount" }] : []),
    ...(options.shipping ? [{ promotionId: shippingPromotion, appliesTo: "shipping" as const, amountOffMinor: options.shipping, reasonCode: "promotion_free_shipping" }] : []),
  ];
  for (const discount of discounts) await owner.query(`INSERT INTO public.commerce_promotion_definitions(promotion_id,definition,active)
    VALUES($1,$2,true)`, [discount.promotionId, { id: discount.promotionId, status: "active", trigger_type: "automatic",
    discount_type: discount.appliesTo === "shipping" ? "free_shipping" : "fixed_amount", discount_value: discount.amountOffMinor,
    applies_to_kind: "order_total", applies_to_payload: {}, stacking_rule: "stackable_with_any", eligibility: {},
    region_availability: ["ZZ"], valid_from: validFrom, valid_to: null,
    redemption_limit_global: null, redemption_limit_per_customer: null }]);
  const identity = { configuration: "regular", ownerNamespace: "example:store", merchantRef: "example:merchant", installationRef: "example:site", offer };
  const original: SelectedOriginal = { ...identity, actorRef, clientId, key: randomUUID(), purpose: "offer-review", lane: "starter-checkout",
    selection: { mode: "subscription", cadenceDays: 28, lines: [{ sku: "ARTICLE-A", quantity: 2 }, { sku: "ARTICLE-B", quantity: 2 }],
      acquisitionCapability: "subscription-acquisition.v1", promoCodes: [] },
    contact: { country: "ZZ", firstName: "Sample", lastName: "Buyer", phone: "000000", line1: "Example 1",
      city: "Example", postalCode: "000", email, purchaser: clientId }, consent: { accepted: true, termsRevision: "terms:1" } };
  const profile: SelectedProfile = { identity, skuIds, skuCodes: ["ARTICLE-A", "ARTICLE-B"],
    offerSelector: "configured:regular", country: "ZZ", currency, termsRevision: "terms:1", cadenceDays: [28],
    minimumUnits: 1, maximumUnits: 12, sourceOrdinal: 1, skuRevisionId: seeded.issued.skuRevisionId, priceListId,
    authority: {
      pricingPolicy: { offerPolicyVersion: "commerce.offer-policy.v2", promotionEngineVersion: "promotion-engine.v2" },
      tax: { included: true, country: "ZZ", category: "standard", vatRateBps: 2300, legalBasis: "Example VAT rule" },
      async verifyDocument(document, envelope) { expect(hash(canonicalCatalogDraftJson(document))).toBe(envelope.documentRevision.digest); },
      priceRead: createPostgresCommercePriceAuthorityReadPort,
      secondShipping: (terms, product) => resolveThresholdShipping(terms, product).grossMinor,
      phase: { applicability: "absent" }, destination: null,
      retention: { minimumPayableMinor: 10, normalCadenceDays: [28, 56], graduationCadenceDays: 56, basisTemplateVersion: 1 },
      async evaluate({ subtotalGrossMinor }) {
        return {
          result: { shippingTerms: { version: "shipping-threshold.v1", currency, flatMinor: 150, freeThresholdMinor: 6000 },
            acquisitionTerms: { schemaVersion: "subscription-acquisition.v1", revision: "acquisition:1",
              initialDiscountBps: 2000, delivery2DiscountBps: 3000, effectiveFrom: validFrom,
              effectiveTo: null, sourcePromotionId: productPromotion },
            shippingGrossMinor: 150, hasShipping: true, discounts, codeRejections: [], codeRejectionDetails: [] },
          decisions: { promotions: discounts.map(row => ({ ref: row.promotionId, revision: "1", validFrom, validTo: null, decision: "applied" })),
            eligibilityRef: "owner:eligibility", claim: "eligible", acquisitionPolicyRef: "owner:acquisition",
            taxRef: "owner:tax", shippingRef: "owner:shipping" },
          secondProductMinor: subtotalGrossMinor - 300,
        };
      },
    },
  };
  return { profile, original };
}

export type GovernedFixture = Awaited<ReturnType<typeof seedGovernedDraft>>;

export async function sampleDraftTime(db: Pool | PoolClient) {
  return selectedInstant((await db.query("SELECT clock_timestamp()::text AS instant")).rows[0]!.instant);
}

export async function prelockDraft(db: PoolClient, { original, profile }: GovernedFixture) {
  await db.query("SET LOCAL lock_timeout='1s'; SET LOCAL statement_timeout='8s'");
  await db.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [original.key]);
  const { skuIds, skuRevisionId, priceListId } = profile;
  const { rows } = await db.query(runtimeSql, ["prelock", original.key, original.clientId, { skuIds, skuRevisionId, priceListId }]);
  expect(rows[0]!.result).toEqual({ kind: "locked" });
}

export async function draftHandoff(db: PoolClient, { original, profile }: GovernedFixture, atTime: string) {
  const { owner, quoteSnapshot } = await evaluateSelectedAdmissionOwner(db, profile, ownerRequest(original, profile.offerSelector), atTime);
  quoteSnapshot.quote.context.atTime = atTime;
  return selectedWrite(original, quoteSnapshot, owner, hash("reviewed-example"));
}

export async function ownerDraft(owner: Pool, fixture: GovernedFixture) {
  return transaction(owner, async db => {
    await db.query("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ");
    await prelockDraft(db, fixture);
    const atTime = await sampleDraftTime(db);
    const value = await draftHandoff(db, fixture, atTime);
    const { rows } = await db.query(ownerSql, [fixture.original.key, fixture.original.clientId, value]);
    const response = rows[0]!.result;
    return { atTime, value, response, id: String(response.orderDraft.orderId).slice(6) };
  });
}

export async function draftEffectCounts(db: Pool | PoolClient) {
  return (await db.query(`SELECT
    (SELECT count(*)::integer FROM public.commerce_orders) orders,
    (SELECT count(*)::integer FROM public.commerce_order_items) items,
    (SELECT count(*)::integer FROM public.commerce_order_adjustments) adjustments,
    (SELECT count(*)::integer FROM public.commerce_order_draft_receipts) receipts,
    (SELECT count(*)::integer FROM public.commerce_promotion_claims) claims,
    (SELECT count(*)::integer FROM public.commerce_promotion_claim_events) events,
    (SELECT count(*)::integer FROM public.outbox_events) outbox`)).rows[0]!;
}
