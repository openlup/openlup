import { z } from "zod";
import { assertEditCurrency } from "./editConsent.js";
import type { SubscriptionQueryExecutor } from "./postgresRenewalStore.js";

const integer = z.number().int();
const positive = integer.positive();
const sku = z.string().min(1);
const constraint = z.record(z.string(), z.unknown()).nullable();
const termLine = z.object({ ordinal: positive, sku, quantity: positive, unitAmountMinor: integer.nonnegative() });
const templateLine = termLine.omit({ ordinal: true }).extend({
  lineId: z.uuid(), variantId: z.uuid(), isAddon: z.boolean(), currency: z.string(),
});
const rowSchema = z.object({
  templateVersion: positive, cadenceDays: positive, constraint,
  scheduledAt: z.iso.datetime(), editCutoffAt: z.iso.datetime(),
  templateCurrency: z.string(), agreementCurrency: z.string(),
  templateLines: z.array(templateLine).min(1), termLines: z.array(termLine).min(1),
});

/** Read a matched template and full renewal agreement in one snapshot for an authorized subject.
 * @experimental
 */
export async function readCompleteEditBaseline(db: SubscriptionQueryExecutor, subject: { clientId: string; subscriptionId: string }) {
  const { rows } = await db.query(`SELECT s.template_version AS "templateVersion",s.cadence_days AS "cadenceDays",
    s.composition_constraint AS "constraint",s.currency_code AS "templateCurrency",r.currency_code AS "agreementCurrency",
    (to_jsonb(s.next_cycle_at AT TIME ZONE 'UTC')#>>'{}')||'Z' AS "scheduledAt",
    (to_jsonb((s.next_cycle_at - make_interval(hours => s.edit_window_hours)) AT TIME ZONE 'UTC')#>>'{}')||'Z' AS "editCutoffAt",
    (SELECT jsonb_agg(jsonb_build_object('lineId',l.id,'variantId',l.variant_id,'sku',k.sku,'isAddon',l.is_addon,
      'quantity',l.quantity,'unitAmountMinor',l.unit_price_minor,'currency',l.currency_code))
      FROM public.subscription_lines l LEFT JOIN public.catalog_skus k ON k.id=l.variant_id WHERE l.subscription_id=s.id) AS "templateLines",
    (SELECT jsonb_agg(jsonb_build_object('ordinal',l.line_ordinal,'sku',l.sku,'quantity',l.quantity,'unitAmountMinor',l.unit_amount_minor)
      ORDER BY l.line_ordinal) FROM public.subscription_renewal_term_lines l WHERE l.subscription_id=r.subscription_id) AS "termLines"
    FROM public.subscriptions s LEFT JOIN public.subscription_renewal_terms r ON r.subscription_id=s.id
    WHERE s.id=$1::uuid AND s.client_id=$2::uuid`, [subject.subscriptionId, subject.clientId]);
  const baseline = rowSchema.safeParse(rows[0]);
  const unavailable = "subscription_edit_disclosure_baseline_unavailable";
  if (rows.length !== 1 || !baseline.success) throw new Error(unavailable);
  const { templateLines, termLines, templateCurrency, agreementCurrency, ...state } = baseline.data;
  assertEditCurrency(templateCurrency, agreementCurrency);
  const bySku = new Map(templateLines.map(line => [line.sku, line]));
  if (bySku.size !== templateLines.length || termLines.length !== templateLines.length) throw new Error(unavailable);
  const lines = termLines.map(term => {
    const template = bySku.get(term.sku);
    if (!template || template.quantity !== term.quantity || template.unitAmountMinor !== term.unitAmountMinor) throw new Error(unavailable);
    assertEditCurrency(agreementCurrency, template.currency);
    return { ...term, lineId: template.lineId, variantId: template.variantId, isAddon: template.isAddon };
  });
  return { ...state, ...subject, currency: agreementCurrency, lines };
}

export type EditAgreementBaseline = Awaited<ReturnType<typeof readCompleteEditBaseline>>;
