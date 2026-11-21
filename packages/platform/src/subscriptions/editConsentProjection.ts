import { isDeepStrictEqual } from "node:util";
import type { SubscriptionEditDisclosure, SubscriptionEditOwnerEvidence, SubscriptionEditRecurringTerms, SubscriptionEditAmount } from "./contracts/editConsent.js";
import type { ExactSubscriptionEditQuote, ExactSubscriptionEditRequest } from "./contracts/exactEdit.js";
import type { PackageEditMoney, PackageEditQuote, PackageEditQuoteLine, PackageEditRequest } from "./contracts/packageEdit.js";
import type { SizedEditRequest } from "./contracts/sizedEdit.js";
import {
  assertEditCurrency, compareEditLines, fingerprintEditAgreement, fingerprintEditProposal, readEditBasis, readEditRecurringTerms, sealEditDisclosure,
} from "./editConsent.js";
import type { EditAgreementBaseline } from "./editConsentBaseline.js";
import { isSizedOptIn } from "./sizedEditContext.js";
import type { quoteSizedEdit } from "./sizedEditQuote.js";

type LegacyPricedLine = { variantId: string; qty: number; isAddon: boolean; quoteLine: PackageEditQuoteLine };
type LaneQuote =
  | { lane: "classic"; request: PackageEditRequest; quote: PackageEditQuote }
  | { lane: "exact"; request: ExactSubscriptionEditRequest; quote: ExactSubscriptionEditQuote }
  | { lane: "sized"; request: SizedEditRequest; normalizedRequest: SizedEditRequest; quote: Awaited<ReturnType<typeof quoteSizedEdit>> };

type LineLabel = (line: { variantId: string; sku: string; isAddon: boolean }, side: "agreed" | "proposed") => string;

/** The pricing owner resolves payable or a labeled estimate for the selected cycle.
 * A bare renewal term amount does not establish its basis.
 */
interface EditDisclosureOwnerFacts {
  agreedUnitBasis(line: EditAgreementBaseline["lines"][number]): { basis: SubscriptionEditAmount["basis"]; evidence: SubscriptionEditOwnerEvidence } | undefined;
  agreed: SubscriptionEditRecurringTerms;
  proposed?: SubscriptionEditRecurringTerms;
  cycleNumber: number;
  cycleEvidence: SubscriptionEditOwnerEvidence;
  labelLine: LineLabel;
}

/** Wrap only the disclosure pricing call. Check the authoritative response before
 * a lane drops summary currency or combines it with frozen lines.
 * @experimental
 */
export function checkEditDisclosureQuotePort<
  Request extends { lines: readonly { sku: string; quantity: number }[] },
  Result extends { quote: { lines: readonly PackageEditQuoteLine[]; totalGross: PackageEditMoney;
    subtotalGross: PackageEditMoney; discountTotalGross: PackageEditMoney } },
>(currency: string, port: { createServerAuthoritativeQuote(request: Request): Promise<Result> }) {
  return { async createServerAuthoritativeQuote(request: Request): Promise<Result> {
    const { lines: expected } = request;
    const result = await port.createServerAuthoritativeQuote(request);
    const { totalGross, subtotalGross, discountTotalGross, lines } = result.quote;
    for (const money of [totalGross, subtotalGross, discountTotalGross]) assertEditCurrency(currency, money?.currency);
    if (lines.length !== expected.length || lines.some((line, index) =>
      line.sku !== expected[index].sku || line.quantity !== expected[index].quantity)) {
      throw new Error("subscription_edit_disclosure_quote_line_mismatch");
    }
    return result;
  } };
}

function commandContent(request: LaneQuote["request"]) {
  const { subscriptionId: _id, expectedTemplateVersion: _version, acceptedQuoteHash: _hash, ...payload } = request;
  return Object.fromEntries(Object.entries(payload).filter(([, value]) => value !== undefined));
}

function pricedLines(input: LaneQuote): LegacyPricedLine[] {
  if (input.lane === "classic") return [
    ...input.quote.baseLines.map(line => ({ ...line, isAddon: false })),
    ...input.quote.addonLines.map(line => ({ ...line, isAddon: true })),
  ];
  if (input.lane === "sized" && input.quote.lines.some(line => line.sku !== line.quoteLine.sku)) {
    throw new Error("subscription_edit_disclosure_quote_line_mismatch");
  }
  return input.quote.lines;
}

/** Match the content-only branches of the current native delegates. */
function keepsAgreement(input: LaneQuote, baseline: EditAgreementBaseline, lines: readonly LegacyPricedLine[]): boolean {
  const matches = (isAddon: boolean) => {
    const current = baseline.lines.filter(line => line.isAddon === isAddon);
    const desired = lines.filter(line => line.isAddon === isAddon);
    return desired.length === current.length && current.every(old => desired.some(line =>
      line.variantId.toLowerCase() === old.variantId && line.qty === old.quantity));
  };
  const sameCadence = input.quote.cadenceDays === baseline.cadenceDays;
  if (input.lane === "classic") return sameCadence && matches(false) && matches(true);

  const request = input.lane === "sized" ? input.normalizedRequest : input.request;
  if (request.action === "add_addon" || request.action === "update_addon_quantity") {
    // Sized add-on actions also use the exact-line delegate.
    const old = baseline.lines.find(line => line.isAddon && line.variantId === request.variantId.toLowerCase());
    if (request.action === "add_addon" && old && old.quantity !== request.qty) throw new Error("subscription_reprice_duplicate_variant");
    return old?.quantity === request.qty;
  }
  if (request.action === "remove_addon") return false;
  if (input.lane === "sized") {
    const rewritesAddons = request.action === "update_bundle" && request.addonLines !== undefined;
    return !isSizedOptIn(request) && sameCadence && matches(false) &&
      input.quote.compositionConstraint !== null && isDeepStrictEqual(baseline.constraint, input.quote.compositionConstraint) &&
      (!rewritesAddons || matches(true));
  }
  if (request.action === "swap_base_line") return request.fromVariantId.toLowerCase() === request.toVariantId.toLowerCase();
  if (request.action === "update_base_mix") return matches(false);
  if (request.action === "update_plan_length") return request.planDays === baseline.cadenceDays && matches(false);
  if (request.action === "update_portion") {
    const full = input.quote.portionModes?.full;
    const priorMode = baseline.constraint?.mode ?? full?.mode;
    const priorFactor = baseline.constraint?.portionFactor ?? full?.factor;
    return priorMode === request.portionMode && priorFactor === input.quote.compositionConstraint?.portionFactor && matches(false);
  }
  return false;
}

/** Legacy quote fields are translated at this adapter edge. The recurring amount has its own owner. */
function projectLegacyQuoteLine(line: LegacyPricedLine, currency: string, label: LineLabel, keep: boolean) {
  const { quoteLine } = line;
  if (!quoteLine || quoteLine.quantity !== line.qty) throw new Error("subscription_edit_disclosure_quote_line_mismatch");
  assertEditCurrency(currency, quoteLine.unitPriceGross?.currency);
  assertEditCurrency(currency, quoteLine.lineSubtotalGross?.currency);
  const identity = { variantId: line.variantId, sku: quoteLine.sku, isAddon: line.isAddon };
  const { amountMinor, currency: unitCurrency } = quoteLine.unitPriceGross;
  return { ...identity, quantity: line.qty, label: keep ? identity.sku : label(identity, "proposed"),
    unitAmount: { amountMinor, currency: unitCurrency, basis: "tax_inclusive" as const } };
}

/** Seal an existing lane's quoted proposal against retained terms and resolved owner facts.
 * @experimental
 */
export function projectEditDisclosure(input: LaneQuote & {
  actorId: string;
  baseline: EditAgreementBaseline;
  owner: EditDisclosureOwnerFacts;
  presentation: SubscriptionEditDisclosure["presentation"];
}) {
  const { actorId, baseline, owner, presentation, quote, request } = input;
  if (request.subscriptionId.toLowerCase() !== baseline.subscriptionId.toLowerCase() ||
    (request.expectedTemplateVersion !== undefined && request.expectedTemplateVersion !== baseline.templateVersion) ||
    quote.expectedTemplateVersion !== baseline.templateVersion) throw new Error("subscription_edit_stale_template");
  const agreedBasis = baseline.lines.map(line => readEditBasis(owner.agreedUnitBasis(line)));

  const agreed = readEditRecurringTerms(owner.agreed);
  const lines = pricedLines(input);
  const keep = keepsAgreement(input, baseline, lines);
  const proposed = keep ? agreed : readEditRecurringTerms(owner.proposed);
  if (agreed.cadence.days !== baseline.cadenceDays || proposed.cadence.days !== quote.cadenceDays) {
    throw new Error("subscription_edit_disclosure_cadence_mismatch");
  }
  if (input.lane === "classic") assertEditCurrency(baseline.currency, input.quote.newRecurringPrice?.currency);
  if (input.lane === "sized") assertEditCurrency(baseline.currency, input.quote.quote.currency);
  const agreedLines = baseline.lines.map((line, index) => ({
    variantId: line.variantId, sku: line.sku, isAddon: line.isAddon, quantity: line.quantity,
    label: owner.labelLine(line, "agreed"),
    unitAmount: { amountMinor: line.unitAmountMinor, currency: baseline.currency, basis: agreedBasis[index].basis },
  }));
  const proposedLines = lines.map(line => projectLegacyQuoteLine(line, baseline.currency, owner.labelLine, keep));
  const disclosure: SubscriptionEditDisclosure = {
    version: 1, currency: baseline.currency, disposition: keep ? "keeps_agreement" : "changes_agreement",
    agreed, proposed, presentation,
    effectiveCycle: { number: owner.cycleNumber, scheduledAt: baseline.scheduledAt,
      editCutoffAt: baseline.editCutoffAt, evidence: owner.cycleEvidence },
    lines: compareEditLines(agreedLines, proposedLines, baseline.currency, keep),
  };
  const action = "action" in request ? request.action : "update_package_template";
  const delegate = input.lane === "sized"
    ? { request: commandContent(input.normalizedRequest), subjectFacts: input.quote.subjectFacts,
      optInFacts: input.quote.optInFacts, catalogFacts: input.quote.catalogFacts }
    : null;
  return sealEditDisclosure(disclosure, {
    actorId, clientId: baseline.clientId, subscriptionId: baseline.subscriptionId, lane: input.lane, action,
    templateVersion: baseline.templateVersion, normalizedRequest: commandContent(request),
    baselineFingerprint: fingerprintEditAgreement([baseline, agreedBasis]), innerQuoteHash: quote.quoteHash,
    proposalFingerprint: fingerprintEditProposal([quote.compositionConstraint, delegate]),
  });
}
