import { createHash } from "node:crypto";
import type { SubscriptionQueryExecutor } from "./postgresRenewalStore.js";

export interface EditAgreementLine {
  ordinal: number; lineId: string; variantId: string; sku: string; isAddon: boolean;
  quantity: number; unitMinor: number;
}
export interface EditAgreementBaseline {
  currency: string; templateVersion: number; lines: readonly EditAgreementLine[]; fingerprint: string;
}
export function exactMinor(value: unknown, code: string, positive = false): number {
  const number = typeof value === "number" ? value : typeof value === "string" && /^(0|[1-9][0-9]*)$/u.test(value) ? Number(value) : NaN;
  if (!Number.isSafeInteger(number) || number < (positive ? 1 : 0)) throw new Error(code);
  return number;
}
export function safeMinor(value: bigint, code: string): number {
  if (value > BigInt(Number.MAX_SAFE_INTEGER) || value < -BigInt(Number.MAX_SAFE_INTEGER)) throw new Error(code);
  return Number(value);
}

/** Additive complete reader; the existing partial/frozen-price readers retain their contracts. */
export async function readCompleteEditBaseline(db: SubscriptionQueryExecutor, subscriptionId: string): Promise<EditAgreementBaseline> {
  const state = (await db.query(`SELECT s.template_version,s.currency_code AS template_currency,t.currency_code AS agreement_currency,
    (SELECT jsonb_agg(jsonb_build_object('lineId',l.id,'variantId',l.variant_id,'sku',k.sku,'isAddon',l.is_addon,
      'quantity',l.quantity,'unitMinor',l.unit_price_minor,'currency',l.currency_code) ORDER BY l.sort_order,l.variant_id)
     FROM public.subscription_lines l LEFT JOIN public.catalog_skus k ON k.id=l.variant_id WHERE l.subscription_id=s.id) AS accepted_lines,
    (SELECT jsonb_agg(jsonb_build_object('ordinal',r.line_ordinal,'sku',r.sku,'quantity',r.quantity,'unitMinor',r.unit_amount_minor)
      ORDER BY r.line_ordinal) FROM public.subscription_renewal_term_lines r WHERE r.subscription_id=s.id) AS term_lines
    FROM public.subscriptions s LEFT JOIN public.subscription_renewal_terms t ON t.subscription_id=s.id WHERE s.id=$1::uuid`, [subscriptionId]).catch(error => { throw new Error("dependency_unavailable", { cause: error }); })).rows[0];
  const missing = "agreement_baseline_unavailable";
  if (!state) throw new Error(missing);
  const currency = state.agreement_currency;
  if (typeof currency !== "string" || !/^[A-Z]{3}$/u.test(currency) || typeof state.template_currency !== "string" || !/^[A-Z]{3}$/u.test(state.template_currency)) {
    throw new Error("agreement_currency_unavailable");
  }
  if (currency !== state.template_currency) throw new Error("agreement_currency_mismatch");
  const accepted = state.accepted_lines as Record<string, unknown>[] | null, terms = state.term_lines as Record<string, unknown>[] | null;
  if (!Array.isArray(accepted) || !accepted.length || !Array.isArray(terms) || terms.length !== accepted.length) throw new Error(missing);
  if (new Set(accepted.map(line => line.sku)).size !== accepted.length || new Set(accepted.map(line => line.variantId)).size !== accepted.length
    || new Set(terms.map(line => line.sku)).size !== terms.length || new Set(terms.map(line => line.ordinal)).size !== terms.length) throw new Error(missing);
  const lines = terms.map(term => {
    const line = accepted.find(line => line.sku === term.sku);
    if (!line || typeof line.lineId !== "string" || typeof line.variantId !== "string" || typeof line.sku !== "string" || !line.sku
      || typeof line.isAddon !== "boolean") throw new Error(missing);
    if (line.currency == null || line.currency === "") throw new Error("agreement_currency_unavailable");
    if (line.currency !== currency) throw new Error("agreement_currency_mismatch");
    const quantity = exactMinor(term.quantity, missing, true), unitMinor = exactMinor(term.unitMinor, missing);
    if (exactMinor(line.quantity, missing, true) !== quantity || exactMinor(line.unitMinor, missing) !== unitMinor) throw new Error(missing);
    safeMinor(BigInt(quantity) * BigInt(unitMinor), missing);
    return { ordinal: exactMinor(term.ordinal, missing, true), lineId: line.lineId, variantId: line.variantId.toLowerCase(), sku: line.sku,
      isAddon: line.isAddon, quantity, unitMinor };
  });
  const templateVersion = exactMinor(state.template_version, missing, true);
  const fingerprint = createHash("sha256").update(JSON.stringify([1,currency,templateVersion,lines.map(line =>
    [line.ordinal,line.lineId,line.variantId,line.sku,line.isAddon,line.quantity,line.unitMinor])]), "utf8").digest("hex");
  return { currency, templateVersion, lines, fingerprint };
}
