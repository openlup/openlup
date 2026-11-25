import type { PgQueryExecutor } from "../data/index.js";
import { withSelectedCatalogAdmissionFence } from "./catalogAdmissionFence.js";
import { evaluateSelectedAdmissionOwner, ownerRequest, selectedInstant, type OwnerRequest, type SelectedProfile } from "./catalogSelectedAdmissionOwner.js";
import { digestText, refuseSelected, SelectedAdmissionRefusal, selectedDigest, selectedMoney, selectedStamp, selectedSubmitInput,
  selectedWrite, selectedUuid, type SelectedOriginal } from "./catalogSelectedAdmissionWrite.js";
import { canonicalCatalogDraftJson as canonical } from "./contracts/draft.js";
import { z } from "./validation.js";
import { selectedSubscriptionQuoteSchema as snapshotSchema } from "./catalogOwnerQuoteSubscription.js";

type Snapshot = z.infer<typeof snapshotSchema>["quote"];
type ReviewedOffer = {
  payable: Snapshot["totalGross"]; ownerQuoteDigest?: string; tokenDigest: string;
  timing(now: Date): { accepted: boolean; reason: string };
  matches(input: { quote: Snapshot; expectedTotal: Snapshot["totalGross"];
    acquisitionTerms: Snapshot["context"]["acquisitionTerms"]; shippingTerms?: Snapshot["context"]["shippingTerms"] }): boolean;
};
type InitialOrder = (db: PgQueryExecutor, orderId: string) => Promise<boolean>;

const sqlIdentity = (error: unknown, code: string, message?: string) => error instanceof Error && !(error instanceof SelectedAdmissionRefusal) && "code" in error
  && error.code === code && (message === undefined || error.message === message);
const same = (left: unknown, right: unknown) => canonical(left) === canonical(right);
const ownerOrigin = z.object({ schemaVersion: z.literal(1), orderId: selectedUuid, receiptKey: z.string(), nativeFingerprint: z.string().regex(/^[0-9a-f]{32}$/u) });
const savedRow = z.object({ id: selectedUuid, client_id: selectedUuid, receipt_key: z.string(), status: z.string(),
  currency_code: z.string(), total_amount_minor: z.union([z.string(), z.number()]), snapshot: z.unknown(),
  stamp: z.unknown(), origin: ownerOrigin, fingerprint: z.string(), completed: z.boolean(), quote_digest: selectedDigest });

async function selectSavedCatalogAdmission(db: PgQueryExecutor, original: SelectedOriginal, token: string, expectedTotal: z.infer<typeof selectedMoney>, initialOrder: InitialOrder) {
  const { rows } = await db.query(`SELECT o.id,o.client_id,o.status,o.currency_code,o.total_amount_minor,o.catalog_receipt_key AS receipt_key,
    o.metadata->'quoteSnapshot' AS snapshot,o.metadata->'catalogAdmissionSubmit' AS stamp,
    o.metadata->'catalogAdmissionOwnerOrigin' AS origin,r.request_fingerprint AS fingerprint,
    o.catalog_acceptance#>>'{admission,quoteDigest}' AS quote_digest,
    EXISTS (SELECT 1 FROM public.commerce_settlement_intents i WHERE i.order_id=o.id AND i.channel_key='sandbox') AS completed
    FROM public.commerce_order_draft_receipts r JOIN public.commerce_orders o ON o.id=r.order_id WHERE r.idempotency_key=$1`, [original.key]);
  const parsed = savedRow.safeParse(rows[0]);
  if (rows.length !== 1 || !parsed.success) return refuseSelected("conflict");
  const order = parsed.data;
  const snapshot = snapshotSchema.safeParse(order.snapshot);
  const stamp = selectedStamp(original, expectedTotal, digestText(token));
  if (!snapshot.success || order.client_id !== original.clientId || order.origin.orderId !== order.id
    || order.origin.receiptKey !== original.key || order.receipt_key !== original.key
    || order.origin.nativeFingerprint !== order.fingerprint || !same(order.stamp, stamp)
    || !same(snapshot.data.quote.totalGross, expectedTotal)) return refuseSelected("conflict");
  const response = { contractVersion: "commerce.v0", orderDraft: { orderId: `order_${order.id}`, status: "draft", paymentStatus: "not_started",
    idempotencyKey: original.key, quoteSnapshot: order.snapshot, replayed: true } };
  try {
    const { rows: replay } = await db.query("SELECT public.catalog_admission_replay_order_draft($1::text,$2::uuid,$3::text,$4::text) AS result",
      [original.key, original.clientId, original.lane, stamp.submitDigest]);
    if (replay.length !== 1 || !same(replay[0]?.result, response)) return refuseSelected("conflict");
  } catch (error) {
    if (sqlIdentity(error, "23505", "commerce_order_draft_idempotency_conflict")) return refuseSelected("conflict");
    if (sqlIdentity(error, "40001", "commerce_order_draft_expired")) return refuseSelected("savedExpired");
    throw error;
  }
  if (!(order.status === "pending_payment" || order.status === "paid") ||
    Number(order.total_amount_minor) !== expectedTotal.amountMinor || order.currency_code !== expectedTotal.currency ||
    !await initialOrder(db, order.id)) return refuseSelected("notPayable");
  return order.completed ? { kind: "replayed" as const, response, status: order.status }
    : { kind: "pending" as const, response, address: original.contact, renewalTerms: snapshot.data.quote.context.starterRenewalTerms };
}

export function submitSelectedCatalogAdmission(pool: Parameters<typeof withSelectedCatalogAdmissionFence>[0], raw: unknown, options: {
  verified: { actorRef: string; clientId: string; key: string; email: string };
  profile?: SelectedProfile; timeoutMs: number; initialOrder: InitialOrder;
  authenticateReview(token: string, request: OwnerRequest): ReviewedOffer | undefined;
}) {
  const { original, quoteAcceptance, expectedTotal, copies } = selectedSubmitInput.parse(JSON.parse(canonical(raw)));
  const { actorRef, clientId, key, contact, selection, consent } = original;
  const { profile, verified, timeoutMs, authenticateReview, initialOrder } = options;
  if (!same({ actorRef, clientId, key, email: contact.email }, verified) || contact.purchaser !== clientId) return refuseSelected("conflict");
  const units = selection.lines[0].quantity + selection.lines[1].quantity;
  const inProfile = profile && Object.entries(profile.identity).every(([name, value]) => same(original[name as keyof typeof original], value))
    && profile.skuCodes.every((sku, index) => sku === selection.lines[index]?.sku)
    && consent.termsRevision === profile.termsRevision && contact.country === profile.country
    && profile.cadenceDays.includes(selection.cadenceDays) && units >= profile.minimumUnits && units <= profile.maximumUnits;
  const scope = inProfile ? { skuIds: profile.skuIds, skuRevisionId: profile.skuRevisionId, priceListId: profile.priceListId } : undefined;
  const request = ownerRequest(original, profile?.offerSelector ?? original.offer.ref);
  let review: ReviewedOffer | undefined;
  return withSelectedCatalogAdmissionFence(pool, { key, clientId, timeoutMs }, scope, async (db, rawInstant, receipt) => {
    try {
      if (receipt) return await selectSavedCatalogAdmission(db, original, quoteAcceptance, expectedTotal, initialOrder);
      if (!review || !profile) return refuseSelected("review");
      const atTime = selectedInstant(rawInstant), timing = review.timing(new Date(atTime));
      if (!timing.accepted) return refuseSelected(timing.reason === "expired" ? "expired" : "review");
      if (!same(review.payable, expectedTotal)) return refuseSelected("integrity");
      const { owner, quoteSnapshot } = await evaluateSelectedAdmissionOwner(db, profile, request, atTime);
      const value = selectedWrite(original, quoteSnapshot, owner, review.tokenDigest, copies);
      const { quote } = quoteSnapshot;
      const { acquisitionTerms, shippingTerms } = quote.context;
      if (!review.ownerQuoteDigest || (review.ownerQuoteDigest !== owner.evidence.quoteDigest && !same(quote.totalGross, review.payable))) {
        return refuseSelected("review", "Obtain and review the current quote.");
      }
      if (review.ownerQuoteDigest !== owner.evidence.quoteDigest) return refuseSelected("moved");
      if (!review.matches({ quote, expectedTotal: quote.totalGross, acquisitionTerms, ...(shippingTerms && { shippingTerms }) })) return refuseSelected("integrity");
      try {
        await db.query("SELECT public.catalog_admission_runtime_checkout($1::text,$2::text,$3::uuid,$4::jsonb) AS result",
          ["write", key, clientId, JSON.stringify(value)]);
      } catch (error) {
        if (!sqlIdentity(error, "55000", "catalog_admission_quote_authority_required")) throw error;
      }
      return refuseSelected("dark");
    } catch (error) {
      if (sqlIdentity(error, "40001")) return refuseSelected("retry");
      throw error;
    }
  }, () => {
    if (original.purpose !== "offer-review" || selection.promoCodes.length !== 0) return refuseSelected("review");
    review = authenticateReview(quoteAcceptance, request);
    if (!review || !selectedMoney.safeParse(review.payable).success) return refuseSelected("review");
    if (!inProfile) return refuseSelected("dark");
    if (!profile.authority) return refuseSelected("line");
  });
}
