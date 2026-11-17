import { createHash } from "node:crypto";
import type { SubscriptionEditConsent, SubscriptionEditDisclosureLine } from "./contracts/editConsent.js";
import type { PackageEditQuoteLine } from "./contracts/packageEdit.js";
import { safeMinor, exactMinor, type EditAgreementBaseline } from "./editConsentBaseline.js";
import { subscriptionRecord, type SubscriptionQueryExecutor } from "./postgresRenewalStore.js";
import type { PackageEditActor } from "./packageEditContracts.js";

export interface EditConsentPricedLine { variantId: string; qty: number; isAddon: boolean; quoteLine: PackageEditQuoteLine }
/** The original lane digest remains byte-for-byte intact inside this fixed projection. */
export function hashEditConsent(consent: SubscriptionEditConsent): string {
  return createHash("sha256").update(JSON.stringify([consent.version,consent.innerQuoteHash,consent.currency,consent.baselineFingerprint,
    consent.lines.map(line => [line.kind,line.variantId,line.sku,line.isAddon,line.agreedQuantity,line.newQuantity,
      line.agreedUnitMinor,line.newUnitMinor,line.deltaMinor,line.subtotalDeltaMinor,line.reason]),
    consent.agreedTotalMinor,consent.newTotalMinor,consent.subtotalDeltaMinor]), "utf8").digest("hex");
}
export function buildEditConsent(baseline: EditAgreementBaseline, innerQuoteHash: string, desired: readonly EditConsentPricedLine[]): SubscriptionEditConsent {
  const code = "agreement_baseline_unavailable", key = (line: { variantId: string; isAddon: boolean }) => `${line.variantId.toLowerCase()}:${line.isAddon}`;
  if (new Set(desired.map(key)).size !== desired.length || !/^[a-f0-9]{64}$/u.test(innerQuoteHash)) throw new Error(code);
  for (const line of desired) {
    const quote = line.quoteLine;
    if (!quote || !quote.unitPriceGross?.currency || !quote.lineSubtotalGross?.currency) throw new Error("agreement_currency_unavailable");
    if (quote.unitPriceGross.currency !== baseline.currency || quote.lineSubtotalGross.currency !== baseline.currency) throw new Error("agreement_currency_mismatch");
    if (quote.quantity !== line.qty || typeof quote.sku !== "string" || !quote.sku
      || exactMinor(quote.lineSubtotalGross.amountMinor, code) !== safeMinor(BigInt(exactMinor(line.qty, code, true)) * BigInt(exactMinor(quote.unitPriceGross.amountMinor, code)), code)) throw new Error(code);
  }
  const lines: SubscriptionEditDisclosureLine[] = baseline.lines.map(old => {
    const next = desired.find(line => key(line) === key(old) && line.quoteLine.sku === old.sku);
    const delta = next ? next.quoteLine.unitPriceGross.amountMinor - old.unitMinor : null;
    return { kind: next ? "retained" : "removed", variantId: old.variantId, sku: old.sku, isAddon: old.isAddon,
      agreedQuantity: old.quantity, newQuantity: next?.qty ?? null, agreedUnitMinor: old.unitMinor,
      newUnitMinor: next?.quoteLine.unitPriceGross.amountMinor ?? null, deltaMinor: delta,
      subtotalDeltaMinor: safeMinor((next ? BigInt(next.qty) * BigInt(next.quoteLine.unitPriceGross.amountMinor) : 0n) - BigInt(old.quantity) * BigInt(old.unitMinor), code),
      reason: !next ? "removed" : old.quantity !== next.qty ? "quantity_changed" : delta !== 0 ? "price_changed" : "unchanged" };
  });
  for (const next of desired) if (!baseline.lines.some(old => key(old) === key(next) && old.sku === next.quoteLine.sku)) {
    lines.push({ kind: "added", variantId: next.variantId.toLowerCase(), sku: next.quoteLine.sku, isAddon: next.isAddon,
      agreedQuantity: null, newQuantity: next.qty, agreedUnitMinor: null, newUnitMinor: next.quoteLine.unitPriceGross.amountMinor,
      deltaMinor: null, subtotalDeltaMinor: next.quoteLine.lineSubtotalGross.amountMinor, reason: "added" });
  }
  const agreedTotalMinor = safeMinor(baseline.lines.reduce((total,line) => total + BigInt(line.quantity) * BigInt(line.unitMinor), 0n), code);
  const newTotalMinor = safeMinor(desired.reduce((total,line) => total + BigInt(line.quoteLine.lineSubtotalGross.amountMinor), 0n), code);
  return { version: 1, currency: baseline.currency, baselineFingerprint: baseline.fingerprint, innerQuoteHash, lines,
    agreedTotalMinor, newTotalMinor, subtotalDeltaMinor: newTotalMinor - agreedTotalMinor };
}
/** Fresh acceptance, including no-ops, selects the same ledger row as the native delegate. */
export async function takeEditConsent(db: SubscriptionQueryExecutor, actor: PackageEditActor, subscriptionId: string, action: string,
  hash: string | undefined, version: number, key: string, now: string): Promise<Record<string, unknown>> {
  const preview = subscriptionRecord((await db.query("SELECT public.subscription_quote_preview_take($1::uuid,$2::uuid,$3::uuid,$4::text,$5::text,$6::integer,$7::text,$8::timestamptz) AS preview",
    [actor.actorId,actor.clientId,subscriptionId,action,hash,version,key,now])).rows[0]?.preview);
  const consent = subscriptionRecord(preview.quote_snapshot).editConsent;
  if (!consent || typeof consent !== "object" || !("version" in consent) || consent.version !== 1) throw new Error("subscription_edit_quote_required");
  return preview;
}
