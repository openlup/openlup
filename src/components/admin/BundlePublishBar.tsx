import { useState } from "react";
import { useTranslation } from "react-i18next";

import { BTN_SECONDARY, BTN_WARN, CARD, CARD_TITLE } from "./bundleAdminUi";

/**
 * The lifecycle bar: publish, unpublish, archive, restore.
 *
 * ACTIVATE IS HUMAN-ONLY, AND ONLY WHEN IT CAN SUCCEED. Publishing requires an
 * active target price (`PRICE_REQUIRED_TO_SELL`) and a non-empty composition
 * (`COMPOSITION_REQUIRED_TO_SELL`). Both are enforced authoritatively by the write
 * routine — this bar does not re-decide them, it reads the same two facts off the
 * detail response and withholds the button when either is missing, naming which.
 * The point is not to prevent the refusal (the server does that) but to avoid
 * offering an action whose only outcome is a rejection the operator cannot act on
 * from a dialog.
 *
 * CONFIRMATION ON THE TWO PUBLISH-STATE TRANSITIONS ONLY. Activate makes a bundle
 * purchasable and deactivate takes it away from customers mid-flight; both are
 * visible outside the admin panel the moment they land. Archive and restore move a
 * bundle between drafting states and are each other's inverse, so a dialog there
 * would train the operator to click through dialogs.
 */

type Action = "activate" | "deactivate";

export function BundlePublishBar({
  status,
  hasActiveTargetPrice,
  componentCount,
  canActivate,
  pending,
  onActivate,
  onDeactivate,
  onArchive,
  onRestore,
}: {
  status: string;
  hasActiveTargetPrice: boolean;
  componentCount: number;
  /** False for an operator whose role may not publish; hides activate outright. */
  canActivate: boolean;
  pending: boolean;
  onActivate: () => void;
  onDeactivate: () => void;
  onArchive: () => void;
  onRestore: () => void;
}) {
  const { t } = useTranslation("admin");
  const [confirming, setConfirming] = useState<Action | null>(null);

  const priceReady = hasActiveTargetPrice;
  const compositionReady = componentCount > 0;
  const preconditionsMet = priceReady && compositionReady;
  const showActivate = canActivate && status === "draft" && preconditionsMet;
  const showDeactivate = canActivate && status === "active";

  function run(action: Action) {
    setConfirming(null);
    if (action === "activate") onActivate();
    else onDeactivate();
  }

  return (
    <section className={CARD}>
      <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
        <h2 className={CARD_TITLE}>{t("admin:adminBundles.publish.title")}</h2>
        <span className="rounded-full bg-offwhite/20 px-3 py-1 text-xs font-bold text-teal-dark">
          {t(`admin:adminBundles.publish.status.${status}`, { defaultValue: status })}
        </span>
      </div>

      {canActivate && status === "draft" && !preconditionsMet && (
        <ul className="mb-3 grid gap-1 rounded-lg bg-warm-amber/15 px-3 py-2 text-xs text-warm-amber">
          {!priceReady && <li>{t("admin:adminBundles.publish.blockedPrice")}</li>}
          {!compositionReady && <li>{t("admin:adminBundles.publish.blockedComposition")}</li>}
        </ul>
      )}

      <div className="flex flex-wrap gap-2">
        {showActivate && (
          <button
            type="button"
            disabled={pending}
            onClick={() => setConfirming("activate")}
            className={BTN_WARN}
          >
            {t("admin:adminBundles.publish.activate")}
          </button>
        )}
        {showDeactivate && (
          <button
            type="button"
            disabled={pending}
            onClick={() => setConfirming("deactivate")}
            className={BTN_SECONDARY}
          >
            {t("admin:adminBundles.publish.deactivate")}
          </button>
        )}
        {status !== "archived" ? (
          <button type="button" disabled={pending} onClick={onArchive} className={BTN_SECONDARY}>
            {t("admin:adminBundles.publish.archive")}
          </button>
        ) : (
          <button type="button" disabled={pending} onClick={onRestore} className={BTN_SECONDARY}>
            {t("admin:adminBundles.publish.restore")}
          </button>
        )}
      </div>

      {confirming !== null && (
        <div
          role="dialog"
          aria-modal="true"
          aria-labelledby="bundle-confirm-title"
          className="mt-4 rounded-xl border border-warm-sand bg-offwhite p-4"
        >
          <h3 id="bundle-confirm-title" className="mb-1 text-sm font-bold text-teal-dark">
            {t(`admin:adminBundles.publish.confirm.${confirming}Title`)}
          </h3>
          <p className="mb-3 text-xs text-text-muted">
            {t(`admin:adminBundles.publish.confirm.${confirming}Body`)}
          </p>
          <div className="flex flex-wrap justify-end gap-2">
            <button type="button" onClick={() => setConfirming(null)} className={BTN_SECONDARY}>
              {t("admin:adminBundles.publish.confirm.cancel")}
            </button>
            <button
              type="button"
              disabled={pending}
              onClick={() => run(confirming)}
              className={BTN_WARN}
            >
              {t("admin:adminBundles.publish.confirm.proceed")}
            </button>
          </div>
        </div>
      )}
    </section>
  );
}
