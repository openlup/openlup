import { useEffect, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";

import { previewBundlePrice } from "@/domains/bundle/adminBundleClient";
import { BffClientError } from "@/lib/bff/client";
import { ambientSettlementProfile } from "@/lib/currency/platformCurrency";
import { formatMoney } from "@/pages/admin/ordersPageUtils";
import {
  BTN_PRIMARY,
  CARD,
  CARD_TITLE,
  FIELD,
  LABEL,
  bundlePreviewKey,
  toMajor,
  toMinor,
} from "./bundleAdminUi";

/**
 * The money, before it is committed.
 *
 * The operator sets ONE target price for the whole bundle; every per-component
 * figure below is the pricing kernel's allocation of that target over TODAY's
 * component prices — derived, never stored, and never computed here. This card
 * asks `preview-price`, which runs the SAME allocator the write path refuses
 * against, so what it shows is what "Zapisz cenę" would save.
 *
 * DEBOUNCED, because the input is a number an operator types digit by digit and
 * each keystroke would otherwise be a request that prices a number they never
 * meant (a lone `1` on the way to `129`). The query key carries the target, so
 * every candidate the operator settles on stays cached.
 *
 * THE AMOUNT'S CURRENCY COMES FROM THE RESPONSE, NEVER FROM THIS COMPONENT. The
 * stored price row inherits its price list's currency, so the resolved code is an
 * answer the server gives — a currency chosen in the browser would be a second
 * authority on what the amount means, and `onSave` still carries `data.currency`
 * and nothing else.
 *
 * What this card may say is WHICH PRICE LIST A FIRST PRICE ANCHORS TO, and only
 * for a bundle that has no answer of its own. A bundle that already carries a
 * currency is previewed with no `currency` in the request, exactly as before, and
 * the server resolves the list from that bundle's own active price row; naming
 * one would resolve `listForCurrency()` INSTEAD of the stored row and silently
 * re-anchor a bundle priced in another currency. A bundle that carries none has
 * no row to resolve from, which is why `preview-price` answered
 * `no_active_price_list` and the save button could never leave its disabled state
 * — the defect this prop exists to close. For that case the request names the
 * currency this deployment settles in, read from the same ambient settlement
 * profile the rest of the admin panel formats money with, never from a field an
 * operator types into.
 */

const DEBOUNCE_MS = 400;

/**
 * True for the one refusal an operator cannot act on without being told which
 * currency has no price list: this deployment holds no ACTIVE `price_lists` row
 * in the currency the preview asked for. The read handler states it as the same
 * `P0002` the write boundary raises, which the BFF maps to `NOT_FOUND` carrying
 * `{ reason }` (`server/_lib/admin-domain/rpcErrors.ts`). Read off `details` the
 * way every other refusal-aware surface reads it, rather than off the message.
 */
function isNoActivePriceList(error: unknown): boolean {
  if (!(error instanceof BffClientError)) return false;
  const details = error.details as { reason?: unknown } | null | undefined;
  return details?.reason === "no_active_price_list";
}

export function BundlePricePreviewCard({
  accessToken,
  code,
  storedTargetPriceMinor,
  storedCurrency,
  savePending,
  onSave,
}: {
  accessToken: string | undefined;
  code: string;
  /** The active target price already stored, if any; seeds the input. */
  storedTargetPriceMinor: number | undefined;
  /**
   * The currency this bundle already carries, or `undefined` when it has never
   * been priced. It decides one thing: whether this card may name a currency in
   * the preview request at all.
   */
  storedCurrency: string | undefined;
  savePending: boolean;
  onSave: (input: { targetPriceMinor: number; currency: string }) => void;
}) {
  const { t, i18n } = useTranslation("admin");
  const [input, setInput] = useState<string>(
    storedTargetPriceMinor === undefined ? "" : String(toMajor(storedTargetPriceMinor)),
  );
  const [debounced, setDebounced] = useState<string>(input);

  useEffect(() => {
    const timer = setTimeout(() => setDebounced(input), DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [input]);

  // A blank input previews the price already stored, which is what the operator
  // sees before touching anything; a parsed one previews the candidate.
  const parsed = debounced.trim() === "" ? undefined : Number(debounced);
  const targetPriceMinor =
    parsed === undefined || Number.isNaN(parsed) || parsed < 0 ? undefined : toMinor(parsed);

  // Which price list the preview is asked about, and whether the request says so.
  // `requestedCurrency` is always the currency the answer will be in, so the
  // refusal below can name it; `proposedCurrency` is `undefined` for every bundle
  // that already carries one, which keeps that request identical to the one this
  // card has always sent.
  const requestedCurrency = storedCurrency ?? ambientSettlementProfile.defaultCurrency;
  const proposedCurrency = storedCurrency === undefined ? requestedCurrency : undefined;

  const preview = useQuery({
    queryKey: bundlePreviewKey(code, targetPriceMinor, proposedCurrency),
    enabled: Boolean(accessToken) && code.length > 0,
    retry: false,
    queryFn: () =>
      previewBundlePrice(accessToken as string, {
        code,
        ...(proposedCurrency === undefined ? {} : { currency: proposedCurrency }),
        ...(targetPriceMinor === undefined ? {} : { targetPriceMinor }),
      }),
  });

  const data = preview.data?.preview;
  // The currency is the RESPONSE's, never this component's: the stored price row
  // inherits its price list's currency, so naming one here would be a second
  // authority on what the amount means. Until a preview answers, there is no
  // currency to format in and the figures are not rendered at all.
  //
  // Formatting goes through the admin panel's EXISTING money formatter rather than
  // a second language-to-locale mapping written here. Reusing it keeps one answer
  // to "how does this panel render money", and spelling a second locale literal
  // would have added counted country tokens to a publishable surface family.
  const currency = data?.currency;
  const money = (minor: number) =>
    currency === undefined
      ? String(minor)
      : formatMoney({ amountMinor: minor, currency }, i18n.language);

  return (
    <section className={CARD}>
      <h2 className={`mb-1 ${CARD_TITLE}`}>{t("admin:adminBundles.price.title")}</h2>
      <p className="mb-4 text-xs text-text-muted">{t("admin:adminBundles.price.help")}</p>

      <div className="mb-4 flex flex-wrap items-end gap-3">
        <div className="flex-1">
          <label className={LABEL} htmlFor="bundle-target-price">
            {t("admin:adminBundles.price.target")}
          </label>
          <input
            id="bundle-target-price"
            type="number"
            min={0}
            step="0.01"
            value={input}
            onChange={(event) => setInput(event.target.value)}
            className={FIELD}
          />
        </div>
        <button
          type="button"
          disabled={savePending || targetPriceMinor === undefined || currency === undefined}
          onClick={() =>
            targetPriceMinor !== undefined &&
            currency !== undefined &&
            onSave({ targetPriceMinor, currency })
          }
          className={BTN_PRIMARY}
        >
          {savePending ? t("admin:adminBundles.price.saving") : t("admin:adminBundles.price.save")}
        </button>
      </div>

      {preview.isLoading ? (
        <p className="text-sm text-text-muted">{t("admin:adminBundles.price.loading")}</p>
      ) : preview.isError ? (
        // The generic refusal tells the operator to check the composition and the
        // target price, which is not true of a deployment holding no price list:
        // both may be perfect and the answer will not change until somebody
        // creates one. So that refusal gets its own copy, naming the currency.
        <p className="text-sm text-warm-amber">
          {isNoActivePriceList(preview.error)
            ? t("admin:adminBundles.price.noPriceList", { currency: requestedCurrency })
            : t("admin:adminBundles.price.error")}
        </p>
      ) : data === undefined ? null : (
        <>
          <dl className="mb-3 grid gap-2 sm:grid-cols-3">
            <div>
              <dt className={LABEL}>{t("admin:adminBundles.price.reference")}</dt>
              <dd className="text-sm font-semibold text-teal-dark">
                {money(data.referenceTotalMinor)}
              </dd>
            </div>
            <div>
              <dt className={LABEL}>{t("admin:adminBundles.price.effective")}</dt>
              <dd className="text-sm font-semibold text-teal-dark">
                {money(data.targetPriceMinor)}
              </dd>
            </div>
            <div>
              <dt className={LABEL}>{t("admin:adminBundles.price.discount")}</dt>
              <dd className="text-sm font-semibold text-teal-dark">
                {money(data.discountTotalMinor)} ({(data.discountBps / 100).toFixed(2)}%)
              </dd>
            </div>
          </dl>

          {data.floorApplied && (
            <p className="mb-3 rounded-lg bg-warm-amber/15 px-3 py-2 text-xs text-warm-amber">
              {t("admin:adminBundles.price.floorApplied")}
            </p>
          )}

          <div className="overflow-x-auto">
            <table className="w-full text-left text-xs">
              <caption className="sr-only">{t("admin:adminBundles.price.tableCaption")}</caption>
              <thead className="text-text-muted">
                <tr>
                  <th scope="col" className="py-1 pr-3 font-semibold">
                    {t("admin:adminBundles.price.colSku")}
                  </th>
                  <th scope="col" className="py-1 pr-3 font-semibold">
                    {t("admin:adminBundles.price.colReference")}
                  </th>
                  <th scope="col" className="py-1 pr-3 font-semibold">
                    {t("admin:adminBundles.price.colAllocated")}
                  </th>
                  <th scope="col" className="py-1 pr-3 font-semibold">
                    {t("admin:adminBundles.price.colUnit")}
                  </th>
                  <th scope="col" className="py-1 font-semibold">
                    {t("admin:adminBundles.price.colDiscount")}
                  </th>
                </tr>
              </thead>
              <tbody>
                {data.componentTargets.map((target) => {
                  const line = data.allocatedLines.find((entry) => entry.sku === target.sku);
                  return (
                    <tr key={target.sku} className="border-t border-offwhite/15">
                      <th scope="row" className="py-1.5 pr-3 font-mono font-normal text-teal-dark">
                        {target.sku}
                        <span className="ml-1 text-text-muted">×{target.quantity}</span>
                        {target.hasSplitPricing && (
                          <span className="ml-2 rounded bg-light-teal px-1.5 py-0.5 text-xxs font-bold text-teal-dark">
                            {t("admin:adminBundles.price.splitPricing")}
                          </span>
                        )}
                      </th>
                      <td className="py-1.5 pr-3 text-text-muted">
                        {money(target.referenceSubtotalMinor)}
                      </td>
                      <td className="py-1.5 pr-3 text-text-muted">
                        {money(target.discountAllocatedMinor)}
                      </td>
                      <td className="py-1.5 pr-3 text-teal-dark">
                        {line ? money(line.effectiveUnitPriceMinor) : "—"}
                      </td>
                      <td className="py-1.5 text-text-muted">
                        {(target.discountBps / 100).toFixed(2)}%
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </>
      )}
    </section>
  );
}
