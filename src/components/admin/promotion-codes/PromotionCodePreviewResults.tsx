import type { PromotionCodePreviewResponse } from "@/domains/commerce/adminPromotionCodesContracts";
import { useTranslation } from "react-i18next";

import { formatMoney, minimumProductPayableLabel } from "./promotionCodeUi";

export function PromotionCodePreviewResults({ preview }: { preview: PromotionCodePreviewResponse }) {
  const { t, i18n } = useTranslation("admin");
  return (
    <div className="grid gap-3 sm:grid-cols-2" aria-live="polite">
      {preview.results.map((result) => (
        <article key={result.scope} className="rounded-card border border-warm-sand bg-offwhite p-4">
          <h3 className="font-display text-base font-semibold text-teal-dark">
            {result.scope === "one_time" ? t("admin:adminPromotionCodes.labels.oneTime") : t("admin:adminPromotionCodes.labels.subscription")}
          </h3>
          <dl className="mt-3 grid grid-cols-2 gap-x-3 gap-y-2 text-sm">
            <dt className="text-text-muted">{t("admin:adminPromotionCodes.previewResults.product")}</dt>
            <dd className="text-right font-mono text-teal-dark">{formatMoney(result.productPayableMinor, i18n.language)}</dd>
            <dt className="text-text-muted">{t("admin:adminPromotionCodes.previewResults.shipping")}</dt>
            <dd className="text-right font-mono text-teal-dark">{formatMoney(result.shippingPayableMinor, i18n.language)}</dd>
            <dt className="text-text-muted">{t("admin:adminPromotionCodes.previewResults.effective")}</dt>
            <dd className="text-right font-mono text-teal-dark">
              {(result.effectiveProductDiscountBps / 100).toLocaleString(i18n.language)}%
            </dd>
            <dt className="text-text-muted">{t("admin:adminPromotionCodes.previewResults.winner")}</dt>
            <dd className="text-right text-teal-dark">
              {result.winner === "code" ? t("admin:adminPromotionCodes.previewResults.codeWinner") : t("admin:adminPromotionCodes.previewResults.automaticWinner")}
            </dd>
          </dl>
          {result.floorApplied && (
            <p className="mt-3 rounded-control bg-warm-amber/20 px-3 py-2 text-xs text-charcoal">
              {t("admin:adminPromotionCodes.previewResults.floor", {
                amount: minimumProductPayableLabel(i18n.language),
              })}
            </p>
          )}
        </article>
      ))}
    </div>
  );
}
