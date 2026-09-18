import { useQuery } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";

import type { BundleAvailabilityView } from "@/domains/bundle/adminBundleReadContracts";
import { fetchSellableBundles } from "@/domains/bundle/sellableBundleClient";
import { CARD, CARD_TITLE, LABEL, sellableBundlesKey } from "./bundleAdminUi";

/**
 * Derived stock for one bundle — what the platform actually computes, and nothing
 * beyond it.
 *
 * WHERE THE FIGURE COMES FROM. Availability is folded in by
 * `bundleAvailabilityService` (bill of materials × the commerce offer-availability
 * port). The ADMIN DETAIL response now carries it, per component, for a bundle of
 * ANY status — which is the whole gain: the sellable feed is live-only by
 * construction, so a draft an operator is about to publish had no derived stock
 * anywhere, and the one moment they most want to know whether it can ship was the
 * one moment nothing would tell them.
 *
 * THE FEED PATH IS KEPT AS THE FALLBACK, not as a duplicate. When the detail
 * carries no availability block the deployment computed none — no stock rail is
 * bound — and this card falls back to matching the live feed by code, with the
 * same reduced copy it has always shown. Null is UNKNOWN in both directions and is
 * never rendered as zero.
 *
 * NOTHING IS RE-DERIVED HERE. The tempting shortcut — reaching past this seam to a
 * raw per-unit stock reader and computing the figure in the browser — would put a
 * second stock derivation in the frontend, disagreeing with the server's whenever
 * thresholds or reservations move. `deriveBundleAvailability` is the one place
 * that folds units into bundles; this card renders its answer, including the
 * per-component rows it was given, and computes only the one presentational
 * quotient below. The hidden stock control plane stays out of this surface
 * entirely, which `inventoryHiddenBoundary` enforces by scanning for its route
 * and client names — so this comment names neither.
 *
 * `sellableNow: null` means UNKNOWN, never zero, and is rendered as such: the
 * kernel fails to unknown when any counted component's figure is missing, and
 * flattening that to "0" would hide a sellable bundle exactly as "unlimited" would
 * oversell one.
 */

const STATUS_TONE: Record<string, string> = {
  available: "bg-light-teal text-teal-dark",
  low_stock: "bg-warm-amber/20 text-warm-amber",
  out_of_stock: "bg-destructive/15 text-destructive",
  unknown: "bg-offwhite/20 text-text-muted",
};

export function BundleStockCard({
  code,
  status,
  availability: detailAvailability,
}: {
  code: string;
  status: string;
  /** From the admin detail. `null` means this deployment computed no stock at all. */
  availability?: BundleAvailabilityView | null;
}) {
  const { t } = useTranslation("admin");
  const isLive = status === "active";
  const fromDetail = detailAvailability ?? null;

  const feed = useQuery({
    queryKey: sellableBundlesKey,
    // Not fetched at all when the detail already answered: the fallback exists for a deployment
    // with no stock rail, not as a second opinion about a bundle the server already described.
    enabled: isLive && fromDetail === null,
    retry: false,
    queryFn: () => fetchSellableBundles(),
  });

  if (fromDetail !== null) {
    return <DerivedStock availability={fromDetail} />;
  }

  const bundle = feed.data?.bundles.find((entry) => entry.code === code);
  const availability = bundle?.availability;

  return (
    <section className={CARD}>
      <h2 className={`mb-1 ${CARD_TITLE}`}>{t("admin:adminBundles.stock.title")}</h2>
      <p className="mb-4 text-xs text-text-muted">{t("admin:adminBundles.stock.help")}</p>

      {!isLive ? (
        <p className="text-sm text-text-muted">{t("admin:adminBundles.stock.notLive")}</p>
      ) : feed.isLoading ? (
        <p className="text-sm text-text-muted">{t("admin:adminBundles.stock.loading")}</p>
      ) : feed.isError ? (
        <p className="text-sm text-warm-amber">{t("admin:adminBundles.stock.error")}</p>
      ) : availability === undefined ? (
        <p className="text-sm text-text-muted">{t("admin:adminBundles.stock.absent")}</p>
      ) : (
        <>
          <div className="mb-3 flex flex-wrap items-center gap-3">
            <span
              className={`rounded-full px-3 py-1 text-xs font-bold ${
                STATUS_TONE[availability.status] ?? STATUS_TONE.unknown
              }`}
            >
              {t(`admin:adminBundles.stock.status.${availability.status}`)}
            </span>
            <span className="text-xs text-text-muted">{availability.reasonCode}</span>
          </div>

          <dl className="grid gap-2 sm:grid-cols-2">
            <div>
              <dt className={LABEL}>{t("admin:adminBundles.stock.sellableNow")}</dt>
              <dd className="text-sm font-semibold text-teal-dark">
                {availability.sellableNow === null
                  ? t("admin:adminBundles.stock.unknownFigure")
                  : availability.sellableNow}
              </dd>
            </div>
            <div>
              <dt className={LABEL}>{t("admin:adminBundles.stock.limitingSku")}</dt>
              <dd className="text-sm">
                {availability.limitingSku === null ? (
                  <span className="text-text-muted">{t("admin:adminBundles.stock.noLimiting")}</span>
                ) : (
                  <mark className="rounded bg-warm-amber/25 px-1.5 py-0.5 font-mono text-xs text-teal-dark">
                    {availability.limitingSku}
                  </mark>
                )}
              </dd>
            </div>
          </dl>

          <p className="mt-3 text-xs text-text-muted">
            {t("admin:adminBundles.stock.perComponentUnavailable")}
          </p>
        </>
      )}
    </section>
  );
}

/**
 * The detail's own answer, per component.
 *
 * The one number computed here is `Math.floor(sellableNow / quantity)` — how many whole bundles a
 * component's units cover. It is presentation, not policy: the kernel already decided the bundle's
 * figure, and this only says WHY, so an operator can tell "order one more of this" from "this
 * bundle is months away". A component the kernel does not count (an add-on) is shown and labelled
 * rather than hidden, because an operator who wonders where a unit went is owed the row.
 */
function DerivedStock({ availability }: { availability: BundleAvailabilityView }) {
  const { t } = useTranslation("admin");

  return (
    <section className={CARD}>
      <h2 className={`mb-1 ${CARD_TITLE}`}>{t("admin:adminBundles.stock.title")}</h2>
      <p className="mb-4 text-xs text-text-muted">{t("admin:adminBundles.stock.help")}</p>

      <div className="mb-3 flex flex-wrap items-center gap-3">
        <span
          className={`rounded-full px-3 py-1 text-xs font-bold ${
            STATUS_TONE[availability.status] ?? STATUS_TONE.unknown
          }`}
        >
          {t(`admin:adminBundles.stock.status.${availability.status}`)}
        </span>
        <span className="text-xs text-text-muted">{availability.reasonCode}</span>
      </div>

      <dl className="mb-4 grid gap-2 sm:grid-cols-2">
        <div>
          <dt className={LABEL}>{t("admin:adminBundles.stock.sellableNow")}</dt>
          <dd className="text-sm font-semibold text-teal-dark">
            {availability.sellableNow === null
              ? t("admin:adminBundles.stock.unknownFigure")
              : availability.sellableNow}
          </dd>
        </div>
        <div>
          <dt className={LABEL}>{t("admin:adminBundles.stock.limitingSku")}</dt>
          <dd className="text-sm">
            {availability.limitingSku === null ? (
              <span className="text-text-muted">{t("admin:adminBundles.stock.noLimiting")}</span>
            ) : (
              <mark className="rounded bg-warm-amber/25 px-1.5 py-0.5 font-mono text-xs text-teal-dark">
                {availability.limitingSku}
              </mark>
            )}
          </dd>
        </div>
      </dl>

      <h3 className={`mb-2 ${LABEL}`}>{t("admin:adminBundles.stock.components")}</h3>
      <div className="overflow-x-auto">
        <table className="w-full text-left text-sm">
          <caption className="sr-only">{t("admin:adminBundles.stock.components")}</caption>
          <thead>
            <tr className="text-xs text-text-muted">
              <th scope="col" className="py-1 pr-3 font-medium">
                {t("admin:adminBundles.stock.componentSku")}
              </th>
              <th scope="col" className="py-1 pr-3 font-medium">
                {t("admin:adminBundles.stock.componentNeeds")}
              </th>
              <th scope="col" className="py-1 pr-3 font-medium">
                {t("admin:adminBundles.stock.componentSellable")}
              </th>
              <th scope="col" className="py-1 font-medium">
                {t("admin:adminBundles.stock.componentBuys")}
              </th>
            </tr>
          </thead>
          <tbody>
            {availability.components.map((component) => {
              const limiting = component.sku === availability.limitingSku;
              return (
                <tr
                  key={component.sku}
                  className={limiting ? "bg-warm-amber/15" : undefined}
                >
                  <th scope="row" className="py-1 pr-3 font-mono text-xs font-normal text-teal-dark">
                    {component.sku}
                    {limiting ? (
                      <span className="ml-2 rounded bg-warm-amber/30 px-1.5 py-0.5 text-[10px] font-bold uppercase">
                        {t("admin:adminBundles.stock.limitingBadge")}
                      </span>
                    ) : null}
                    {component.isAddon ? (
                      <span className="ml-2 text-[10px] text-text-muted">
                        {t("admin:adminBundles.stock.componentAddon")}
                      </span>
                    ) : null}
                  </th>
                  <td className="py-1 pr-3">{component.quantity}</td>
                  <td className="py-1 pr-3">
                    {component.sellableNow === null
                      ? t("admin:adminBundles.stock.unknownFigure")
                      : component.sellableNow}
                  </td>
                  <td className="py-1">
                    {component.sellableNow === null
                      ? t("admin:adminBundles.stock.unknownFigure")
                      : Math.floor(component.sellableNow / component.quantity)}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      <p className="mt-3 text-xs text-text-muted">{t("admin:adminBundles.stock.derivedHere")}</p>
    </section>
  );
}
