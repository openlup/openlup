import { z } from "zod";
import type { RenewalLine, RenewalLinePricing, RenewalPricingSnapshot, RenewalRetainedTerms } from "./contracts/renewal.js";
import { subscriptionRecord, type SubscriptionQueryExecutor } from "./postgresRenewalStore.js";
import { bestEffortNativePurchaseTemplate, resolveNativePurchasePriceList } from "./nativePurchasePriceList.js";

const amount = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const cadence = z.number().int().positive().max(2_147_483_647);
const quote = z.record(z.string(), z.unknown());
export const renewalShippingTermsSchema = z.object({ version: z.literal("shipping-threshold.v1"),
  currency: z.string().regex(/^[A-Z]{3}$/), flatMinor: amount.max(2_147_483_647), freeThresholdMinor: amount.max(2_147_483_647) }).strict();
const pricedLine = z.object({ sku: z.string().min(1), quantity: cadence, unitAmountMinor: amount,
  isAddon: z.boolean(), quoteLine: quote }).strict();
export const nativeRenewalTermsSchema = z.object({ version: z.literal("native.renewal-terms.v1"),
  shippingTerms: renewalShippingTermsSchema.optional(), minimumPayableMinor: amount.positive().optional(),
  normalCadenceDays: z.array(cadence).min(1).optional(), linePricing: z.array(pricedLine).max(100).optional(),
  starterPack: z.object({ schemaVersion: z.literal("1"), starterIntervalDays: cadence, basisTemplateVersion: cadence,
    delivery2: z.object({ discountBps: amount.max(10_000), discountMinor: amount, basisSubtotalMinor: amount }).strict(),
    graduation: z.object({ cadenceDays: cadence, sizeConstraint: quote.optional(), lines: z.array(z.object({
      sku: z.string().min(1), qty: cadence.max(99), sortOrder: amount, isAddon: z.boolean(), quoteLine: quote }).strict()).min(1).max(100) }).strict(),
  }).strict().optional(),
}).strict().superRefine((terms, context) => {
  const marker = terms.starterPack;
  if (marker && (!terms.minimumPayableMinor || !terms.normalCadenceDays?.includes(marker.graduation.cadenceDays)
    || marker.delivery2.basisSubtotalMinor - marker.delivery2.discountMinor < terms.minimumPayableMinor)) {
    context.addIssue({ code: "custom", message: "subscription_renewal_acquisition_terms_invalid" });
  }
  for (const line of marker?.graduation.lines ?? []) {
    if (!Number.isSafeInteger(subscriptionRecord(line.quoteLine.unitPriceGross).amountMinor)
      || subscriptionRecord(line.quoteLine.lineSubtotalGross).amountMinor !== Number(subscriptionRecord(line.quoteLine.unitPriceGross).amountMinor) * line.qty) {
      context.addIssue({ code: "custom", message: "subscription_renewal_graduation_money_invalid" });
    }
  }
  if (terms.linePricing && new Set(terms.linePricing.map(line => line.sku)).size !== terms.linePricing.length) {
    context.addIssue({ code: "custom", message: "subscription_renewal_line_pricing_ambiguous" });
  }
});

export function nativeRetainedTerms(row: Record<string, unknown>): RenewalRetainedTerms | undefined {
  const facts = subscriptionRecord(row.purchase_facts);
  return Object.hasOwn(facts, "renewalTerms") ? nativeRenewalTermsSchema.parse(facts.renewalTerms) : undefined;
}

function currentPricing(row: Record<string, unknown>, lines: readonly RenewalLine[], terms: RenewalRetainedTerms): RenewalLinePricing[] {
  const stored = row.graduation_pricing ?? terms.linePricing ?? [];
  const prices = z.array(pricedLine).parse(stored);
  return lines.flatMap(line => {
    const price = prices.find(value => value.sku === line.sku && value.quantity === line.quantity && value.unitAmountMinor === line.unitAmountMinor);
    return price ? [price] : [];
  });
}

/** Only complete evidence is a list anchor; zero is a real price. */
function listAnchor(prices: readonly RenewalLinePricing[], count: number): number | null {
  if (!count || prices.length !== count) return null;
  let total = 0;
  for (const line of prices) {
    const components = line.quoteLine.pricingComponents;
    if (!Array.isArray(components)) return null;
    let found: number | null = null;
    for (const value of components) {
      if (!value || typeof value !== "object") continue;
      const component = value as Record<string, unknown>;
      if (component.componentType !== "base_unit") continue;
      if (typeof component.amountMinor !== "number" || !Number.isFinite(component.amountMinor) || component.amountMinor < 0) return null;
      found = (found ?? 0) + component.amountMinor;
    }
    if (found === null) return null;
    total += found;
  }
  return total;
}

// Exact integer money: amount × basis points can exceed 2^53, where float rounding drifts by a minor unit.
const ceilBps = (amount: number, bps: number) => Number((BigInt(amount) * BigInt(bps) + 9_999n) / 10_000n);
const roundBps = (amount: number, bps: number) => Number((BigInt(amount) * BigInt(bps) * 2n + 10_000n) / 20_000n);

/** Same threshold boundary as the shipping owner, without a cross-module runtime dependency. */
export function nativeRenewalPrice(row: Record<string, unknown>, lines: readonly RenewalLine[], logicalCycle: number): RenewalPricingSnapshot {
  const facts = subscriptionRecord(row.purchase_facts), terms = nativeRetainedTerms(row);
  const subtotal = lines.reduce((sum, line) => sum + line.quantity * line.unitAmountMinor, 0);
  const prices = terms ? currentPricing(row, lines, terms) : [];
  const marker = terms?.starterPack;
  let discount = 0;
  if (marker && logicalCycle === 2) {
    const list = listAnchor(prices, lines.length), saved = marker.delivery2;
    const raw = subtotal === saved.basisSubtotalMinor ? saved.discountMinor : list !== null && list > 0
      ? subtotal - ceilBps(list, 10_000 - saved.discountBps) : roundBps(subtotal, saved.discountBps);
    discount = Math.min(Math.max(0, Math.trunc(raw)), Math.max(0, subtotal - terms!.minimumPayableMinor!));
  }
  const product = subtotal - discount, shippingTerms = terms?.shippingTerms;
  if (shippingTerms && shippingTerms.currency !== row.currency_code) throw new Error("subscription_shipping_currency_mismatch");
  const remaining = shippingTerms ? Math.max(0, shippingTerms.freeThresholdMinor - product) : null;
  const shipping = shippingTerms ? (remaining! > 0 ? shippingTerms.flatMinor : 0) : amount.parse(facts.shippingAmountMinor);
  amount.positive().parse(product + shipping);
  return { currency: String(row.currency_code), totalAmountMinor: product + shipping, shippingAmountMinor: shipping,
    agreementPolicy: "lock_until_edit", proration: "none", ...(terms ? {
      productSubtotalAmountMinor: subtotal, discountAmountMinor: discount, linePricing: prices,
      ...(shippingTerms ? { shippingTerms } : {}),
      ...(marker && logicalCycle === 2 ? { acquisition: { reasonCode: "starter_pack_delivery_2" as const,
        discountMinor: discount, basisTemplateVersion: marker.basisTemplateVersion } } : {}),
    } : {}) };
}

/** Caller holds the subscription lock. No clock, payment, schedule advance or new phase flag. */
export async function graduateNativeRenewal(db: SubscriptionQueryExecutor, row: Record<string, unknown>): Promise<boolean> {
  const terms = nativeRetainedTerms(row), marker = terms?.starterPack;
  if (!marker) return false;
  if (!row.activation_cycle_id || row.activation_cycle_paid !== true || row.paid_cycle_count !== row.next_cycle_number) {
    throw new Error("subscription_renewal_cycle_correlation_required");
  }
  if (Number(row.paid_cycle_count) + 1 < 3) return false;
  const full = Number(row.template_version) === marker.basisTemplateVersion;
  if (!full && (Number(row.cadence_days) !== marker.starterIntervalDays || terms!.normalCadenceDays!.includes(Number(row.cadence_days)))) return false;
  const id = String(row.subscription_id);
  const open = await db.query(`SELECT 1 FROM public.subscription_renewal_operations WHERE subscription_id=$1::uuid
    AND state NOT IN ('succeeded','refused') UNION ALL SELECT 1 FROM public.subscription_cycles WHERE subscription_id=$1::uuid
    AND status IN ('payment_pending','retry_scheduled') LIMIT 1`, [id]);
  if (open.rows.length) throw new Error("subscription_starter_graduation_open_cycle");
  await bestEffortNativePurchaseTemplate(db, async () => {
    const current = (await db.query("SELECT price_list_id,currency_code FROM public.subscriptions WHERE id=$1::uuid", [id])).rows[0];
    if (!current || current.price_list_id != null || current.currency_code != null) return;
    const context = await resolveNativePurchasePriceList(db, String(row.activation_order_id));
    if (context.priceListId) await db.query(`UPDATE public.subscriptions SET price_list_id=$2::uuid,currency_code=$3
      WHERE id=$1::uuid AND price_list_id IS NULL AND currency_code IS NULL`, [id, context.priceListId, context.currency]);
    if (context.reason) console.warn("subscription_price_list_unresolved", context.reason);
  });
  const original = z.array(z.object({ lineOrdinal: cadence, sku: z.string(), quantity: cadence, unitAmountMinor: amount }).strict()).parse(row.lines);
  const prices = currentPricing(row, original, terms!);
  let finalLines = original, finalPricing = prices;
  if (full) {
    const template = await db.query(`SELECT k.sku,l.is_addon,l.sort_order FROM public.subscription_lines l
      JOIN public.catalog_skus k ON k.id=l.variant_id WHERE l.subscription_id=$1::uuid`, [id]);
    const roles = new Map(template.rows.map(value => [String(value.sku), value]));
    const addons = new Set(original.filter(line => roles.get(line.sku)?.is_addon
      ?? prices.find(price => price.sku === line.sku)?.isAddon).map(line => line.sku));
    const next = marker.graduation.lines.map(line => ({ sku: line.sku, quantity: line.qty,
      unitAmountMinor: amount.parse(subscriptionRecord(line.quoteLine.unitPriceGross).amountMinor), isAddon: line.isAddon, quoteLine: line.quoteLine }));
    const unique = new Set(next.map(line => line.sku));
    if (unique.size !== next.length || next.some(line => addons.has(line.sku))) throw new Error("subscription_starter_graduation_invalid_lines");
    const needed = [...unique, ...addons];
    const known = await db.query("SELECT sku,id FROM public.catalog_skus WHERE sku=ANY($1::text[])", [needed]);
    if (known.rows.length !== needed.length) throw new Error("subscription_starter_graduation_unknown_sku");
    const ids = new Map(known.rows.map(value => [String(value.sku), String(value.id)]));
    const sortOrder = (sku: string) => marker.graduation.lines.find(line => line.sku === sku)?.sortOrder
      ?? Number(roles.get(sku)?.sort_order ?? original.find(line => line.sku === sku)!.lineOrdinal - 1);
    finalLines = [...next, ...original.filter(line => addons.has(line.sku))]
      .sort((a, b) => sortOrder(a.sku) - sortOrder(b.sku) || ids.get(a.sku)!.localeCompare(ids.get(b.sku)!))
      .map((line, index) => ({
      lineOrdinal: index + 1, sku: line.sku, quantity: line.quantity, unitAmountMinor: line.unitAmountMinor }));
    finalPricing = finalLines.flatMap(line => {
      const price = next.find(value => value.sku === line.sku) ?? prices.find(value => value.sku === line.sku);
      return price ? [price] : [];
    });
    await db.query("DELETE FROM public.subscription_lines WHERE subscription_id=$1::uuid AND NOT is_addon", [id]);
    for (const line of next) await db.query(`INSERT INTO public.subscription_lines(subscription_id,variant_id,quantity,sort_order,is_addon,unit_price_minor,currency_code)
      VALUES($1::uuid,$2::uuid,$3,$4,$5,$6,$7)`, [id, ids.get(line.sku), line.quantity,
      marker.graduation.lines.find(value => value.sku === line.sku)!.sortOrder, line.isAddon, line.unitAmountMinor, row.currency_code]);
    // Purchase attachment materializes renewal lines first. Retain an acquisition
    // addon in the template too when no template row has yet been materialized.
    for (const line of original.filter(value => addons.has(value.sku) && !roles.has(value.sku))) {
      await db.query(`INSERT INTO public.subscription_lines(subscription_id,variant_id,quantity,sort_order,is_addon,unit_price_minor,currency_code)
        VALUES($1::uuid,$2::uuid,$3,$4,true,$5,$6)`, [id, ids.get(line.sku), line.quantity, sortOrder(line.sku), line.unitAmountMinor, row.currency_code]);
    }
    await db.query("DELETE FROM public.subscription_renewal_term_lines WHERE subscription_id=$1::uuid", [id]);
    for (const line of finalLines) await db.query(`INSERT INTO public.subscription_renewal_term_lines(subscription_id,line_ordinal,sku,quantity,unit_amount_minor)
      VALUES($1::uuid,$2,$3,$4,$5)`, [id, line.lineOrdinal, line.sku, line.quantity, line.unitAmountMinor]);
  }
  await db.query("UPDATE public.subscriptions SET cadence_days=$2,template_version=template_version+1,updated_at=now() WHERE id=$1::uuid", [id, marker.graduation.cadenceDays]);
  const mode = full ? "full" : "cadence_only";
  const eventType = full ? "subscription.starter_graduated" : "subscription.starter_cadence_normalized";
  let eventKey = `${full ? "starter-graduation" : "starter-cadence-normalize"}:${id}:${marker.basisTemplateVersion}`;
  // Preserve pre-upgrade customer history, including a pre-claimed fallback key.
  while ((await db.query(`SELECT 1 FROM public.subscription_events
    WHERE subscription_id=$1::uuid AND idempotency_key=$2 AND event_type<>$3`, [id, eventKey, eventType])).rows.length) {
    eventKey = `system:${eventKey}`;
  }
  await db.query(`INSERT INTO public.subscription_events(subscription_id,event_type,idempotency_key,payload)
    VALUES($1::uuid,$2,$3,$4::jsonb)`, [id, eventType, eventKey,
    JSON.stringify({ mode, basisTemplateVersion: marker.basisTemplateVersion, templateVersion: Number(row.template_version) + 1,
      cadenceDays: marker.graduation.cadenceDays, before: original, lines: finalLines, linePricing: finalPricing,
      ...(full && marker.graduation.sizeConstraint ? { sizeConstraint: marker.graduation.sizeConstraint } : {}),
      priceAgreementPolicy: { kind: "lock_until_edit", proration: "none", cycleEffect: "future_unlocked_cycles_only" } })]);
  return true;
}
