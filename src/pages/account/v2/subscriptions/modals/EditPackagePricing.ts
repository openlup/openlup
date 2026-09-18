import type { CustomerSubscriptionActionRequest } from "@/domains/customers/selfServiceContracts";
import type { CustomerSubscriptionPreviewResponse } from "@/domains/customers/subscriptionFacadeContracts";
import { STOREFRONT_VARIANT_SLUGS, packArt } from "#storefront-can-art";
import type { SubscriptionCatalogProduct } from "@/domains/subscription/subscriptionCatalogContracts";
import { estimateDeliveryWindow } from "@/domains/subscription/deliveryEstimate";
import { DELIVERY_DISPATCH_POLICY } from "#delivery-dispatch-policy";
import { BffClientError } from "@/lib/bff/client";
import { formatCurrencyMinor } from "@/lib/currency/formatMinor";
import { idempotencyKey } from "../../../DashboardPanelUtils";
import type { AccountLang } from "../../lib/format";
import { formatDeliveryWindowLong } from "../../lib/format";
import type { RecipeMixEntry, Subscription } from "../../lib/subscriptionEditModel";
import type { AddChip, MixLabels, MixRow } from "./EditPackageSections";

/** Naming/label helpers shared by every derived list in the package editor. */
export interface EditPackageCatalogView {
  byVariant: ReadonlyMap<string, SubscriptionCatalogProduct>;
  bySlug: ReadonlyMap<string, SubscriptionCatalogProduct>;
  labelForSlug: (slug: string) => string;
  breed: string;
}

export function nameForVariant(view: EditPackageCatalogView, variantId: string): string {
  const slug = view.byVariant.get(variantId)?.slug ?? null;
  return slug ? view.labelForSlug(slug) : variantId;
}

export function buildMixRows(
  view: EditPackageCatalogView,
  mix: readonly RecipeMixEntry[],
  total: number,
): MixRow[] {
  return mix.map((entry) => {
    const slug = view.byVariant.get(entry.variantId)?.slug ?? null;
    return {
      variantId: entry.variantId,
      qty: entry.qty,
      name: nameForVariant(view, entry.variantId),
      image: slug ? packArt(slug, view.breed).src : null,
      pct: Math.round((entry.qty / (total || 1)) * 100),
    };
  });
}

/** Selectable catalog flavours that are not already in the mix. */
export function availableFlavorChips(
  view: EditPackageCatalogView,
  mix: readonly RecipeMixEntry[],
): AddChip[] {
  return STOREFRONT_VARIANT_SLUGS.filter((slug) => {
    const product = view.bySlug.get(slug);
    if (!product || product.selectable === false) return false;
    return !mix.some((entry) => entry.variantId === product.variantId);
  }).map((slug) => ({ slug, label: view.labelForSlug(slug) }));
}

export function buildAddonItems(
  view: EditPackageCatalogView,
  addonIds: ReadonlySet<string>,
): Array<{ variantId: string; label: string; active: boolean }> {
  return STOREFRONT_VARIANT_SLUGS.flatMap((slug) => {
    const product = view.bySlug.get(slug);
    if (!product) return [];
    return [{
      variantId: product.variantId,
      label: view.labelForSlug(slug),
      active: addonIds.has(product.variantId),
    }];
  });
}

/** Review-phase bullet list: mix, plan, add-ons, and the unchanged delivery window. */
export function buildReviewLines(
  r: (key: string, opts?: Record<string, unknown>) => string,
  view: EditPackageCatalogView,
  input: {
    subscription: Subscription;
    lang: AccountLang;
    mix: readonly RecipeMixEntry[];
    planDays: number;
    total: number;
    addonIds: ReadonlySet<string>;
  },
): string[] {
  const window = input.subscription.nextCycleAt
    ? estimateDeliveryWindow(input.subscription.nextCycleAt, DELIVERY_DISPATCH_POLICY)
    : null;
  return [
    r("mix", { list: input.mix.map((e) => `${e.qty}× ${nameForVariant(view, e.variantId)}`).join(", ") }),
    r("plan", { days: input.planDays, cans: input.total }),
    input.addonIds.size > 0
      ? r("addons", { list: [...input.addonIds].map((id) => `1× ${nameForVariant(view, id)}`).join(", ") })
      : r("addonsNone"),
    r("nextUnchanged", { range: formatDeliveryWindowLong(window, input.lang) }),
  ];
}

/** True when the draft differs from the stored template in mix, plan length, or add-ons. */
export function packageEditHasChanges(input: {
  mix: readonly RecipeMixEntry[];
  currentMix: readonly RecipeMixEntry[];
  planDays: number;
  currentPlan: number;
  addonIds: ReadonlySet<string>;
  currentAddons: ReadonlySet<string>;
}): boolean {
  const mixChanged = input.mix.length !== input.currentMix.length ||
    input.mix.some((entry) =>
      input.currentMix.find((c) => c.variantId === entry.variantId)?.qty !== entry.qty);
  const addonsChanged = input.addonIds.size !== input.currentAddons.size ||
    [...input.addonIds].some((id) => !input.currentAddons.has(id));
  return mixChanged || input.planDays !== input.currentPlan || addonsChanged;
}

/** Mix-section copy, including the per-row aria-label builders. */
export function buildMixLabels(
  m: (key: string, opts?: Record<string, unknown>) => string,
  minTotal: number,
): MixLabels {
  return {
    mix: m("mix"),
    mixHint: m("mixHint"),
    mixMinimum: m("mixMinimum", { min: minTotal }),
    editorLabel: m("mixEditorLabel"),
    distributeEvenly: m("distributeEvenly"),
    decrease: (row) => m("mixDecrease", { flavor: row.name, count: row.qty }),
    increase: (row) => m("mixIncrease", { flavor: row.name, count: row.qty }),
    remove: (row) => m("mixRemove", { flavor: row.name }),
  };
}

export function packageTemplateAction(input: {
  subscription: Subscription;
  planDays: number;
  mix: RecipeMixEntry[];
  addonIds: ReadonlySet<string>;
  acceptedQuoteHash?: string;
}): CustomerSubscriptionActionRequest {
  return {
    action: "update_package_template",
    idempotencyKey: idempotencyKey("package-template"),
    subscriptionId: input.subscription.subscriptionId,
    planDays: input.planDays,
    recipes: input.mix.map((entry) => ({ variantId: entry.variantId, qty: entry.qty })),
    addons: [...input.addonIds].map((variantId) => ({ variantId, qty: 1 })),
    expectedTemplateVersion: input.subscription.templateVersion,
    acceptedQuoteHash: input.acceptedQuoteHash,
  };
}

/**
 * The three money rows of the package-edit review, denominated by **the quote** and
 * written in the reader's language.
 *
 * Both facts used to be asserted here instead of asked for: a currency code and a fixed
 * regional locale, so a reader of the other language saw the default language's number
 * formatting, and a deployment settling elsewhere would have mislabelled a live quote.
 * Neither needed asserting. `currentRecurringPrice`, `newRecurringPrice` and `delta` are
 * all `commerceMoneySchema`, so the preview states its own denomination; and
 * `EditPackageModal` already holds the `lang` it hands to two neighbouring helpers on
 * this same screen.
 *
 * The quote's answer beats the settlement profile's here, which is why this is not the
 * repointing E2-F5 gave the storefront: the customer is about to accept *this* quote, so
 * the number and what it means have to come out of one answer, or a configuration change
 * between the preview and the apply could show a price nobody agreed to.
 */
export function priceRowsForPreview(
  preview: NonNullable<CustomerSubscriptionPreviewResponse["preview"]["packageEdit"]>,
  labels: { current: string; next: string; delta: string },
  lang: AccountLang,
) {
  return [
    { label: labels.current, value: formatMoney(preview.currentRecurringPrice, lang) },
    { label: labels.next, value: formatMoney(preview.newRecurringPrice, lang) },
    {
      label: labels.delta,
      value: formatDelta(preview.delta, lang),
      tone: preview.delta.amountMinor > 0 ? "negative" as const : preview.delta.amountMinor < 0 ? "positive" as const : "neutral" as const,
    },
  ];
}

/** Immutable add/remove of one add-on variant in the editor's selection set. */
export function toggledVariantSet(previous: ReadonlySet<string>, variantId: string): Set<string> {
  const next = new Set(previous);
  if (next.has(variantId)) next.delete(variantId);
  else next.add(variantId);
  return next;
}

export type PreviewErrorKind = "generic" | "moq";

/**
 * Classifies a failed package-edit preview. The BFF maps a reprice rejection to
 * a 4xx whose `message` stays the coarse long-standing label and whose
 * `details.reason` carries the precise `subscription_reprice_*` code (error
 * envelopes are not parsed against a data schema, so `details` is `unknown`).
 * Only the order-minimum rejection is actionable by the customer; everything
 * else, including a non-BFF throw, keeps the generic banner.
 */
export function previewErrorKind(caught: unknown): PreviewErrorKind {
  if (!(caught instanceof BffClientError)) return "generic";
  const details = caught.details;
  const reason = details && typeof details === "object" && "reason" in details
    ? (details as { reason?: unknown }).reason
    : null;
  return reason === "subscription_reprice_below_minimum_order_units" ? "moq" : "generic";
}

/**
 * `lang` is the locale, passed through unchanged: a bare language subtag rather than a
 * language-plus-region tag. `Intl` resolves the two to byte-identical currency output for
 * every code and amount this modal can reach, so naming a region as well would state a
 * second fact nothing here reads - the same reasoning `DEFAULT_MONEY_LANG` in
 * `formatMinor.ts` is written down under, and the shape that keeps this file from
 * spending regional slack the storefront family does not have.
 */
function formatMoney(money: { amountMinor: number; currency: string }, lang: AccountLang): string {
  return formatCurrencyMinor(money.amountMinor, { currency: money.currency, locale: lang });
}

/**
 * The signed delta row. The zero case goes through the same formatter as every other
 * row rather than restating a hand-written `"0,00 zł"`, which was a currency, a locale
 * and a separator convention welded into one string literal - and which would have kept
 * saying `zł` for a quote in anything else.
 */
function formatDelta(money: { amountMinor: number; currency: string }, lang: AccountLang): string {
  const magnitude = formatMoney({ ...money, amountMinor: Math.abs(money.amountMinor) }, lang);
  if (money.amountMinor === 0) return magnitude;
  return `${money.amountMinor > 0 ? "+" : "-"}${magnitude}`;
}
