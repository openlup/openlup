/**
 * Shared presentation constants and query keys for the admin bundle configurator.
 *
 * The class strings are the ones the admin catalog surface already uses -
 * `CatalogDocumentPanel` imports them here;
 * they live here rather than being restated in each of the five cards so that a
 * change to the admin field look is one edit, and so no card drifts into its own
 * spacing. Nothing here renders — importing this file pulls in no React.
 *
 * The query keys are colocated for the same reason: the page invalidates what the
 * cards read, so both halves must name the same cache entry, and a literal typed
 * twice is a stale card nobody can explain.
 */

export const CARD = "rounded-2xl border border-warm-sand bg-white p-5";
export const CARD_TITLE = "font-display text-[16px] font-semibold text-teal-dark";
/**
 * `focus-ring` rather than the `focus:border-… focus:outline-none` pair the older
 * admin forms carry: DESIGN.md §8 asks for a keyboard-only ring, and the bare
 * `focus:` variants fire on mouse clicks too. The a11y surface ratchet counts that
 * pair as `bareFocus` — it does not scan `src/components/admin/`, so this is a
 * choice rather than a forced one, but writing the anti-pattern into a constant
 * five cards share is exactly how it would spread into files that ARE scanned.
 */
export const FIELD =
  "focus-ring w-full rounded-md border border-offwhite/15 bg-white px-3 py-2 text-sm text-teal-dark placeholder:text-text-muted";
export const LABEL = "block text-xs text-text-muted";
export const ERR = "mt-1 text-[11px] text-destructive";
export const BTN_PRIMARY =
  "focus-ring min-h-[44px] rounded-md bg-teal px-4 py-2 text-sm font-semibold text-charcoal transition hover:bg-teal/90 disabled:opacity-50";
export const BTN_SECONDARY =
  "focus-ring min-h-[44px] rounded-md border border-warm-sand bg-white px-4 py-2 text-sm font-semibold text-teal-dark transition hover:bg-offwhite disabled:opacity-50";
export const BTN_WARN =
  "focus-ring min-h-[44px] rounded-md bg-warm-amber px-4 py-2 text-sm font-semibold text-charcoal transition hover:bg-warm-amber/90 disabled:opacity-50";

/** Cache key for the lifecycle-inclusive bundle list. */
export const bundleListKey = (status: string) => ["admin-bundles", "list", status] as const;

/** Cache key for one bundle's full admin detail. */
export const bundleDetailKey = (code: string) => ["admin-bundles", "detail", code] as const;

/**
 * Cache key for a price preview; the target is part of the key so each candidate
 * is cached.
 *
 * `currency` is the currency the REQUEST names, which a request resolving the
 * bundle's own price list does not do — the two are different questions asked of
 * the same bundle and the same target, and they get different answers. Without it
 * here, the first save would flip the request from "anchor this to the settlement
 * currency" to "resolve this from the bundle's own row" under an unchanged key,
 * and the cached answer to the first question would be served for the second.
 */
export const bundlePreviewKey = (
  code: string,
  targetPriceMinor: number | undefined,
  currency?: string,
) => ["admin-bundles", "preview", code, targetPriceMinor ?? "stored", currency ?? "own"] as const;

/** Cache key for the public sellable feed, which is where derived stock lives. */
export const sellableBundlesKey = ["admin-bundles", "sellable"] as const;

/**
 * The currency a bundle already carries, or `undefined` when it has never been
 * priced — the one fact that decides whether the price card may name a currency
 * for it at all.
 *
 * Two facts feed it rather than one. `resolvedCurrency` is the server's own
 * answer whenever an active price row resolves to a price list, and it is the
 * answer to trust. A stored row's own currency is the fallback for the single
 * shape that answer cannot carry: a row whose price list no longer joins arrives
 * as `null`, which must not read as "never priced" — that misreading is exactly
 * how a bundle priced outside the settlement currency would be re-anchored to it.
 *
 * `resolvedCurrency` is declared here as optional AND nullable although the
 * contract says `z.string().nullable()`, because `tsconfig.app.json` sets
 * `strict: false`: with `strictNullChecks` off the app's inferred type for that
 * field collapses to plain `string`, so a signature naming `string | null` is
 * rejected at the call site while the value is `null` at runtime. The widened
 * parameter is the honest one — this function runs under both that config and
 * the `strictNullChecks: true` one the specs use — and the `??` below is doing
 * real work the app's type checker cannot see.
 */
export function storedBundleCurrency(
  bundle:
    | { resolvedCurrency?: string | null; prices: readonly { currency: string }[] }
    | undefined,
): string | undefined {
  return (
    bundle?.resolvedCurrency ?? bundle?.prices.find((entry) => entry.currency !== "")?.currency
  );
}

/**
 * Minor units -> the major-unit number an amount input edits, and back. Kept here
 * because three cards move between the two and an off-by-100 in either direction
 * is a mispriced bundle rather than a display bug.
 */
export const toMajor = (minor: number): number => minor / 100;
export const toMinor = (major: number): number => Math.round(major * 100);
