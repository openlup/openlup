import { createHash } from "node:crypto";
import { canonicalCatalogDraftJson as canonical } from "./contracts/draft.js";
import { catalogAdmissionRefSchema as ref } from "./catalogAdmissionSchema.js";
import { z } from "./validation.js";
import type { SelectedSubscriptionQuote, buildSelectedSubscriptionOwnerQuote } from "./catalogOwnerQuoteSubscription.js";

const labels = {
  conflict: "commerce_order_draft_idempotency_conflict", savedExpired: "commerce_order_draft_expired",
  retry: "catalog_admission_visibility_changed", notPayable: "starter_checkout_not_payable",
  dark: "catalog_admission_quote_authority_required", review: "starter_quote_refresh_required",
  expired: "catalog_admission_quote_expired", price: "catalog_admission_price_context_required",
  membership: "catalog_admission_membership_authority_unavailable", line: "catalog_admission_line_ineligible",
  integrity: "catalog_admission_evidence_binding_mismatch", moved: "catalog_admission_quote_digest_moved",
} as const;
const remedies = {
  conflict: "Replay the original authorized request.", savedExpired: "Use the checkout recovery flow for an eligible original purchase.",
  retry: "Retry the same request with the same idempotency key.", notPayable: "Use checkout recovery for an eligible original purchase.",
  dark: "Governed checkout is unavailable for this selection. Use a supported offer or replay the original request.",
  review: "Review the offer from your authorized checkout session.", expired: "Obtain and review a fresh quote.",
  price: "Use a selection supported on this installation.", membership: "Use a selection supported on this installation.",
  line: "Use a selection supported on this installation.",
  integrity: "Recover the original purchase evidence with its owner and replay the original request.",
  moved: "Obtain and review the current quote.",
} as const;
type Refusal = keyof typeof labels;
export class SelectedAdmissionRefusal extends Error {
  declare readonly code?: "23505" | "40001";
  readonly label: (typeof labels)[Refusal];
  constructor(reason: Refusal, message?: string) {
    super(message ?? remedies[reason]);
    this.label = labels[reason];
    if (reason === "conflict") Object.assign(this, { code: "23505" });
    if (reason === "savedExpired" || reason === "retry") Object.assign(this, { code: "40001" });
  }
}
export const refuseSelected = (reason: Refusal, message?: string): never => { throw new SelectedAdmissionRefusal(reason, message); };
export const digestText = (text: string) => createHash("sha256").update(text, "utf8").digest("hex");
export const selectedDigest = z.string().regex(/^[a-f0-9]{64}$/u);
export const selectedUuid = z.guid().refine(value => value === value.toLowerCase());
export const selectedMoney = z.strictObject({ amountMinor: z.number().int().positive(), currency: z.string().regex(/^[A-Z]{3}$/u) });

const text = (max: number) => z.string().min(1).max(max).refine(value => value.trim() === value);
const line = z.strictObject({ sku: z.string().regex(/^[A-Za-z0-9._:-]{1,128}$/u), quantity: z.number().int().min(1).max(99) });
const originalSchema = z.strictObject({
  actorRef: selectedUuid, clientId: selectedUuid, purpose: ref, ownerNamespace: ref, merchantRef: ref, installationRef: ref,
  lane: z.literal("starter-checkout"), key: z.string().min(8).max(120).regex(/^[!-~]+$/u), configuration: ref,
  offer: z.strictObject({ ref, version: ref }),
  selection: z.strictObject({ mode: z.literal("subscription"), cadenceDays: z.number().int().min(1).max(3660),
    lines: z.tuple([line, line]).refine(([first, second]) => first.sku !== second.sku),
    acquisitionCapability: z.literal("subscription-acquisition.v1"), promoCodes: z.array(ref).max(20) }),
  contact: z.strictObject({ country: z.string().regex(/^[A-Z]{2}$/u), firstName: text(64), lastName: text(64), phone: text(32),
    line1: text(200), line2: z.string().max(200).optional(), city: text(200), postalCode: text(32),
    email: text(160).refine(value => /^[^@\s]+@[^@\s]+\.[^@\s]+$/u.test(value)), purchaser: selectedUuid }),
  consent: z.strictObject({ accepted: z.literal(true), termsRevision: ref }),
});
export const selectedSubmitInput = z.strictObject({
  original: originalSchema, quoteAcceptance: z.string(), expectedTotal: selectedMoney, copies: z.record(z.string(), z.unknown()).optional(),
});
export type SelectedOriginal = z.infer<typeof originalSchema>;

export function selectedStamp(original: SelectedOriginal, payable: z.infer<typeof selectedMoney>, acceptanceTokenDigest: string) {
  const { ownerNamespace, actorRef, clientId, lane, key: requestKey } = original;
  return { schemaVersion: 1 as const, ownerNamespace, actorRef, clientId, lane, requestKey, acceptanceTokenDigest,
    submitDigest: digestText(canonical(["catalog.checkout-governed-submit.v1", original, { payable, acceptanceTokenDigest }])) };
}

type Snapshot = SelectedSubscriptionQuote;
type Line = Snapshot["quote"]["lines"][number];
function stripObservation({ catalogFacts: { atTime: _atTime, ...catalogFacts }, ...line }: Line) {
  return { ...line, catalogFacts };
}
function reviewQuote({ lines, context: { starterRequest: _starterRequest, starterRenewalTerms, ...context }, ...quote }: Snapshot["quote"]) {
  const { linePricing, starterPack } = starterRenewalTerms;
  const { graduation } = starterPack;
  return { ...quote, lines: lines.map(stripObservation), context: { ...context, starterRenewalTerms: {
    ...starterRenewalTerms, linePricing: linePricing.map(row => ({ ...row, quoteLine: stripObservation(row.quoteLine) })),
    starterPack: { ...starterPack, graduation: { ...graduation, lines: graduation.lines.map(row => ({ ...row, quoteLine: stripObservation(row.quoteLine) })) } },
  } } };
}

export function selectedWrite(original: SelectedOriginal, quoteSnapshot: Snapshot,
  { document, evidence }: ReturnType<typeof buildSelectedSubscriptionOwnerQuote>, acceptanceTokenDigest: string, copies?: Record<string, unknown>) {
  const { quote } = quoteSnapshot;
  const { subtotalGross, discountTotalGross, shippingGross, shippingDiscountGross, totalGross, netTotal, taxTotal } = quote;
  const draft = { contractVersion: "commerce.v0", source: "commerce.order_draft.bff.v0", status: "draft", paymentStatus: "not_started",
    currency: quote.currency, taxIncluded: quote.taxIncluded, lines: quote.lines, discounts: quote.discounts, context: quote.context,
    totals: { subtotalGross, discountTotalGross, ...(shippingGross && { shippingGross }), ...(shippingDiscountGross && { shippingDiscountGross }),
      totalGross, netTotal, taxTotal } };
  const { renewalTerms } = document;
  const { phase } = renewalTerms;
  const ownerQuoteDigest = evidence.quoteDigest;
  const submit = { ...selectedStamp(original, totalGross, acceptanceTokenDigest), ownerQuoteDigest, reviewedPayable: totalGross };
  if (copies) {
    const projected = reviewQuote(quote);
    const valid: Record<string, unknown> = {
      original, quoteSnapshot: { contractVersion: quoteSnapshot.contractVersion, quote: projected },
      draft: { ...draft, lines: projected.lines, context: projected.context }, evidence, renewalTerms, phase, submit,
      ownerDocument: document, ownerQuoteDigest, secondTotalMinor: document.reviewedProjection.secondTotalMinor,
    };
    for (const [key, value] of Object.entries(copies)) {
      if (!Object.hasOwn(valid, key) || canonical(value) !== canonical(valid[key])) return refuseSelected("integrity");
    }
  }
  return { original, quoteSnapshot, draft, evidence, renewalTerms, phase, submit };
}
