import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { z } from "zod";
import type { SubscriptionEditConsent, SubscriptionEditDisclosureLine } from "./contracts/editConsent.js";
import type { PackageEditMoney, PackageEditQuoteLine } from "./contracts/packageEdit.js";
import { safeMinor, exactMinor, type EditAgreementBaseline } from "./editConsentBaseline.js";
import { subscriptionRecord, type SubscriptionQueryExecutor } from "./postgresRenewalStore.js";
import type { PackageEditActor, ReadSubscriptionEditCatalogAdmission } from "./packageEditContracts.js";

export interface EditConsentPricedLine { variantId: string; qty: number; isAddon: boolean; quoteLine: PackageEditQuoteLine }
const digest = z.string().regex(/^[a-f0-9]{64}$/u);
const amount = z.number().int().nonnegative();
const quantity = z.number().int().positive();
const lineIdentity = { variantId: z.uuid(), sku: z.string().min(1), isAddon: z.boolean(), subtotalDeltaMinor: z.number().int() };
const disclosureSchema = z.strictObject({ version: z.literal(1), currency: z.string().regex(/^[A-Z]{3}$/u),
  baselineFingerprint: digest, innerQuoteHash: digest, agreedTotalMinor: amount, newTotalMinor: amount, subtotalDeltaMinor: z.number().int(),
  noChange: z.strictObject({ livePriceDiffers: z.boolean() }).optional(),
  lines: z.array(z.discriminatedUnion("kind", [
    z.strictObject({ ...lineIdentity, kind: z.literal("retained"), agreedQuantity: quantity, newQuantity: quantity,
      agreedUnitMinor: amount, newUnitMinor: amount, deltaMinor: z.number().int(), reason: z.enum(["unchanged", "price_changed", "quantity_changed"]) }),
    z.strictObject({ ...lineIdentity, kind: z.literal("added"), agreedQuantity: z.null(), newQuantity: quantity,
      agreedUnitMinor: z.null(), newUnitMinor: amount, deltaMinor: z.null(), reason: z.literal("added") }),
    z.strictObject({ ...lineIdentity, kind: z.literal("removed"), agreedQuantity: quantity, newQuantity: z.null(),
      agreedUnitMinor: amount, newUnitMinor: z.null(), deltaMinor: z.null(), reason: z.literal("removed") }),
  ])).min(1),
});
const applyResult = z.looseObject({
  status: z.enum(["applied", "replayed", "noop"]), subscriptionId: z.uuid(), action: z.string(),
  subscriptionStatus: z.string().min(1), nextCycleAt: z.string().nullable(),
  templateVersion: z.number().int().positive(), eventId: z.uuid().nullable(),
  originalStatus: z.enum(["applied", "noop"]).optional(),
});

/** A successful native return must describe exactly the command that was executed. */
export function decodeEditResult<Action extends string>(rows: readonly Record<string, unknown>[], column: string, id: string,
  action: Action, replayStatus?: "applied" | "noop") {
  if (rows.length !== 1) throw new Error("subscription_edit_result_unreadable");
  const value = subscriptionRecord(rows[0][column]);
  if (value.status === "refused" && typeof value.reason === "string" && value.reason) throw new Error(value.reason);
  const result = applyResult.safeParse(value);
  if (!result.success || result.data.subscriptionId !== id.toLowerCase() || result.data.action !== action
    || (result.data.status === "noop" ? result.data.eventId !== null : result.data.status === "applied" && result.data.eventId === null)
    || (replayStatus !== undefined && result.data.status !== replayStatus)) throw new Error("subscription_edit_result_unreadable");
  return replayStatus ? { ...result.data, action, status: "replayed" as const, originalStatus: replayStatus } : { ...result.data, action };
}

/** Match the originally submitted command before reading today’s pricing or binding. */
export async function readEditReceipt(db: SubscriptionQueryExecutor, actor: PackageEditActor, id: string, key: string,
  action: string, payload: Record<string, unknown>): Promise<{
    rows: Record<string, unknown>[]; status: "applied" | "noop"; result: Record<string, unknown>;
  } | null> {
  const { rows } = await db.query(`SELECT r.*,r.command=jsonb_build_object('clientId',$1::uuid,'subscriptionId',$2::uuid,
    'action',$3::text,'payload',$4::jsonb) AND r.quote_hash IS NOT DISTINCT FROM ($4::jsonb->>'acceptedQuoteHash') AS matches
    FROM public.subscription_command_receipts r WHERE r.actor_id=$5::uuid AND r.idempotency_key=$6::text`,
  [actor.clientId,id,action,payload,actor.actorId,key]);
  if (rows.length === 0) return null;
  const prior = rows[0];
  if (rows.length !== 1) throw new Error("subscription_edit_result_unreadable");
  if (prior.matches !== true) throw new Error("subscription_command_idempotency_conflict");
  const result = subscriptionRecord(prior.result), status = prior.status;
  if (status === "refused" && typeof result.reason === "string") throw new Error(result.reason);
  if (status !== "applied" && status !== "noop") throw new Error("subscription_command_idempotency_conflict");
  return { rows, status, result };
}

export async function readEditCatalogEvidence(db: SubscriptionQueryExecutor, read: ReadSubscriptionEditCatalogAdmission | undefined,
  input: Parameters<ReadSubscriptionEditCatalogAdmission>[1]) {
  if (!read) return;
  const lines = input.lines.map(({ variantId,qty,isAddon }) => ({ variantId,qty,isAddon }));
  const evidence = await read(db, { ...input,lines });
  if (!evidence) return;
  const desired = new Map(lines.map(line => [line.variantId.toLowerCase(), line.qty]));
  const selections = new Map(evidence.skuRevisions.map(line => [line.reference.skuId, line.quantity]));
  if (desired.size !== input.lines.length || selections.size !== evidence.skuRevisions.length
    || selections.size !== desired.size || [...desired].some(([id, qty]) => selections.get(id) !== qty)) {
    throw new Error("customer_self_service_invalid_offer_membership");
  }
  // The native delegate owns current-head, membership and exact price-entry verification.
  return { heads: evidence.heads, skuRevisions: evidence.skuRevisions, priceContextVersions: evidence.priceContextVersions, offerEvidence: {} };
}

/** Preserve submitted content separately from the normalized delegate request. */
export function consentRequest(input: { subscriptionId?: string; acceptedQuoteHash?: string; expectedTemplateVersion?: number }) {
  const { subscriptionId: _id, acceptedQuoteHash: _hash, expectedTemplateVersion: _version, ...request } = input;
  return JSON.parse(JSON.stringify(request)) as Record<string, unknown>;
}

export function agreedEditTotal(baseline: EditAgreementBaseline): PackageEditMoney {
  const total = baseline.lines.reduce((sum, line) => sum + BigInt(line.quantity) * BigInt(line.unitMinor), 0n);
  return { amountMinor: safeMinor(total, "agreement_baseline_unavailable"), currency: baseline.currency };
}

export function assertEditIntent(baseline: EditAgreementBaseline, request: { action?: string; variantId?: string; fromVariantId?: string; toVariantId?: string }) {
  const has = (variant: string | undefined) => baseline.lines.some(line => line.variantId === variant?.toLowerCase());
  if (request.action === "add_addon" && has(request.variantId)
    || request.action === "swap_base_line" && request.fromVariantId?.toLowerCase() !== request.toVariantId?.toLowerCase() && has(request.toVariantId)) {
    throw new Error("subscription_reprice_duplicate_variant");
  }
}
/** Check summary currency before a lane's existing projection discards it. */
export function assertEditQuoteCurrency(currency: string, quote: { totalGross: PackageEditMoney; subtotalGross: PackageEditMoney; discountTotalGross: PackageEditMoney }): void {
  for (const money of [quote.totalGross,quote.subtotalGross,quote.discountTotalGross]) {
    if (!money || typeof money.currency !== "string" || !/^[A-Z]{3}$/u.test(money.currency)) throw new Error("agreement_currency_unavailable");
    if (money.currency !== currency) throw new Error("agreement_currency_mismatch");
  }
}

/** Check the authoritative response before lines are projected onto edit identities. */
export function assertRecurringEditQuote(currency: string, expected: readonly { sku: string; quantity: number }[], quote: {
  totalGross: PackageEditMoney; subtotalGross: PackageEditMoney; discountTotalGross: PackageEditMoney;
  lines: readonly PackageEditQuoteLine[];
}): void {
  assertEditQuoteCurrency(currency, quote);
  if (!Array.isArray(quote.lines) || quote.lines.length !== expected.length) throw new Error("subscription_reprice_line_count_mismatch");
  for (const [index, line] of quote.lines.entries()) {
    if (line?.sku !== expected[index].sku || line.quantity !== expected[index].quantity) throw new Error("subscription_reprice_quote_line_mismatch");
  }
  if (quote.discountTotalGross.amountMinor !== 0) throw new Error("subscription_reprice_quote_has_adjustments");
  const code = "subscription_reprice_quote_total_mismatch";
  const sum = quote.lines.reduce((total, line) => total + BigInt(exactMinor(line.lineSubtotalGross?.amountMinor, code)), 0n);
  const subtotal = safeMinor(sum, code);
  if (quote.totalGross.amountMinor !== subtotal || quote.subtotalGross.amountMinor !== subtotal) throw new Error(code);
}
/** The original lane digest remains byte-for-byte intact inside this fixed projection. */
export function hashEditConsent(consent: SubscriptionEditConsent): string {
  return createHash("sha256").update(JSON.stringify([consent.version,consent.innerQuoteHash,consent.currency,consent.baselineFingerprint,
    consent.lines.map(line => [line.kind,line.variantId,line.sku,line.isAddon,line.agreedQuantity,line.newQuantity,
      line.agreedUnitMinor,line.newUnitMinor,line.deltaMinor,line.subtotalDeltaMinor,line.reason]),
    consent.agreedTotalMinor,consent.newTotalMinor,consent.subtotalDeltaMinor,
    ...(consent.noChange ? [consent.noChange.livePriceDiffers] : [])]), "utf8").digest("hex");
}

/** Same content must reflect the exact set and change tests used by the chosen delegate. */
export function isEditContentNoop(input: {
  lane: "classic" | "exact" | "sized"; action: string; request: Record<string, unknown>;
  baseline: EditAgreementBaseline; desired: readonly EditConsentPricedLine[]; current: Record<string, unknown>;
  cadenceDays: number; constraint: Record<string, unknown> | null;
  fullMode?: { mode: string; factor: number }; optIn?: boolean;
}) {
  const { lane, action, request, baseline, desired, current, cadenceDays, constraint, fullMode } = input;
  const matchesRole = (isAddon: boolean) => {
    const proposed = desired.filter(line => line.isAddon === isAddon), agreed = baseline.lines.filter(line => line.isAddon === isAddon);
    return proposed.length === agreed.length && proposed.every(line => agreed.some(old => old.variantId === line.variantId.toLowerCase() && old.quantity === line.qty));
  };
  const sameCadence = Number(current.cadence_days) === cadenceDays;
  if (lane === "classic") return sameCadence && matchesRole(false) && matchesRole(true);
  if (lane === "sized") return !input.optIn && sameCadence && matchesRole(false) && constraint !== null
    && isDeepStrictEqual(current.composition_constraint, constraint) && (!Array.isArray(request.addonLines) || matchesRole(true));
  if (action === "swap_base_line") return String(request.fromVariantId).toLowerCase() === String(request.toVariantId).toLowerCase();
  if (action === "update_addon_quantity") return matchesRole(true);
  if (action === "update_base_mix") return matchesRole(false);
  if (action === "update_plan_length") return sameCadence && matchesRole(false);
  if (action === "update_portion") {
    const prior = current.composition_constraint == null ? {} : subscriptionRecord(current.composition_constraint);
    return matchesRole(false) && (prior.mode ?? fullMode?.mode) === request.portionMode
      && (prior.portionFactor ?? fullMode?.factor) === constraint?.portionFactor;
  }
  return false;
}

export function buildEditConsent(baseline: EditAgreementBaseline, innerQuoteHash: string, desired: readonly EditConsentPricedLine[], keepAgreement = false): SubscriptionEditConsent {
  const code = "agreement_baseline_unavailable", key = (line: { variantId: string; isAddon: boolean }) => `${line.variantId.toLowerCase()}:${line.isAddon}`;
  if (new Set(desired.map(line => line.variantId.toLowerCase())).size !== desired.length || !/^[a-f0-9]{64}$/u.test(innerQuoteHash)) throw new Error(code);
  for (const line of desired) {
    const quote = line.quoteLine;
    if (!quote || !quote.unitPriceGross?.currency || !quote.lineSubtotalGross?.currency) throw new Error("agreement_currency_unavailable");
    if (quote.unitPriceGross.currency !== baseline.currency || quote.lineSubtotalGross.currency !== baseline.currency) throw new Error("agreement_currency_mismatch");
    if (quote.quantity !== line.qty || typeof quote.sku !== "string" || !quote.sku
      || exactMinor(quote.lineSubtotalGross.amountMinor, code) !== safeMinor(BigInt(exactMinor(line.qty, code, true)) * BigInt(exactMinor(quote.unitPriceGross.amountMinor, code)), code)) throw new Error(code);
  }
  const lines: SubscriptionEditDisclosureLine[] = baseline.lines.map(old => {
    const next = desired.find(line => key(line) === key(old) && line.quoteLine.sku === old.sku);
    const agreed = { variantId: old.variantId, sku: old.sku, isAddon: old.isAddon, agreedQuantity: old.quantity, agreedUnitMinor: old.unitMinor };
    const before = BigInt(old.quantity) * BigInt(old.unitMinor);
    if (!next) return { ...agreed, kind: "removed", newQuantity: null, newUnitMinor: null, deltaMinor: null,
      subtotalDeltaMinor: safeMinor(-before, code), reason: "removed" };
    const newUnitMinor = next.quoteLine.unitPriceGross.amountMinor, deltaMinor = newUnitMinor - old.unitMinor;
    return { ...agreed, kind: "retained", newQuantity: next.qty, newUnitMinor, deltaMinor,
      subtotalDeltaMinor: safeMinor(BigInt(next.qty) * BigInt(newUnitMinor) - before, code),
      reason: old.quantity !== next.qty ? "quantity_changed" : deltaMinor !== 0 ? "price_changed" : "unchanged" };
  });
  for (const next of desired) if (!baseline.lines.some(old => key(old) === key(next) && old.sku === next.quoteLine.sku)) {
    lines.push({ kind: "added", variantId: next.variantId.toLowerCase(), sku: next.quoteLine.sku, isAddon: next.isAddon,
      agreedQuantity: null, newQuantity: next.qty, agreedUnitMinor: null, newUnitMinor: next.quoteLine.unitPriceGross.amountMinor,
      deltaMinor: null, subtotalDeltaMinor: next.quoteLine.lineSubtotalGross.amountMinor, reason: "added" });
  }
  const agreedTotalMinor = agreedEditTotal(baseline).amountMinor;
  const newTotalMinor = safeMinor(desired.reduce((total,line) => total + BigInt(line.quoteLine.lineSubtotalGross.amountMinor), 0n), code);
  if (keepAgreement) return { version: 1, currency: baseline.currency, baselineFingerprint: baseline.fingerprint, innerQuoteHash,
    agreedTotalMinor, newTotalMinor: agreedTotalMinor, subtotalDeltaMinor: 0,
    noChange: { livePriceDiffers: lines.some(line => line.deltaMinor !== 0) },
    lines: baseline.lines.map(line => ({ kind: "retained", variantId: line.variantId, sku: line.sku, isAddon: line.isAddon,
      agreedQuantity: line.quantity, newQuantity: line.quantity, agreedUnitMinor: line.unitMinor, newUnitMinor: line.unitMinor,
      deltaMinor: 0, subtotalDeltaMinor: 0, reason: "unchanged" })) };
  return { version: 1, currency: baseline.currency, baselineFingerprint: baseline.fingerprint, innerQuoteHash, lines,
    agreedTotalMinor, newTotalMinor, subtotalDeltaMinor: newTotalMinor - agreedTotalMinor };
}
/** Fresh acceptance, including no-ops, selects the same ledger row as the native delegate. */
export async function takeEditConsent(db: SubscriptionQueryExecutor, actor: PackageEditActor, subscriptionId: string, action: string,
  hash: string | undefined, version: number, key: string, now: string, request: Record<string, unknown>): Promise<Record<string, unknown>> {
  const { rows } = await db.query("SELECT public.subscription_quote_preview_take($1::uuid,$2::uuid,$3::uuid,$4::text,$5::text,$6::integer,$7::text,$8::timestamptz) AS preview",
    [actor.actorId,actor.clientId,subscriptionId,action,hash,version,key,now]);
  if (rows.length !== 1) throw new Error("subscription_edit_quote_required");
  const preview = subscriptionRecord(rows[0].preview), snapshot = subscriptionRecord(preview.quote_snapshot);
  const consent = disclosureSchema.safeParse(snapshot.editConsent);
  if (!consent.success || !snapshot.consentRequest) throw new Error("subscription_edit_quote_required");
  if (!z.uuid().safeParse(preview.id).success || preview.subscription_id !== subscriptionId.toLowerCase() || preview.client_id !== actor.clientId.toLowerCase()
    || preview.action !== action || preview.quote_hash !== hash || preview.template_version !== version
    || hashEditConsent(consent.data) !== hash || !isDeepStrictEqual(snapshot.consentRequest, request)) throw new Error("subscription_edit_quote_drift");
  return preview;
}
