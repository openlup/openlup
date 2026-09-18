import type { TFunction } from "i18next";
import type { OmsOrderDetail } from "@/domains/commerce/omsContracts";
import { formatDate } from "./ordersPageUtils";
import { compactParts } from "@/lib/utils";

export function ProviderOpsSla({
  detail,
  locale,
  t,
}: {
  detail: OmsOrderDetail;
  locale: string;
  t: TFunction;
}) {
  if (detail.providerOpsStatus === "none") return null;
  const sla = detail.providerOpsSla;
  const status = sla?.status ?? "ok";
  return (
    <div
      data-testid="admin-oms-provider-ops-sla"
      className={[
        "mb-4 rounded-md border p-3",
        status === "breached"
          ? "border-warm-coral/35 bg-warm-coral/5"
          : status === "watch" || status === "paused_non_shipping_day"
            ? "border-warm-amber/35 bg-warm-amber/5"
            : "border-teal/25 bg-teal/5",
      ].join(" ")}
    >
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <p className="text-xs font-semibold uppercase text-text-muted">{t("admin:adminOms.detail.omnipackPendingPick")}</p>
          <p className="text-sm font-semibold text-teal-dark">
            {t(`admin:adminOms.providerOpsStatus.${detail.providerOpsStatus}`)}
          </p>
        </div>
        {sla ? (
          <span className="rounded-full border border-current px-2 py-0.5 text-xs font-semibold text-teal-dark">
            {t(`admin:adminOms.providerOpsSla.${sla.status}`)}
          </span>
        ) : null}
      </div>
      <p className="mt-2 text-xs text-text-muted">
        {compactParts([
          detail.providerOrderId ? t("admin:adminOms.detail.providerOrderIdValue", { value: detail.providerOrderId }) : null,
          sla?.deadlineAt ? t("admin:adminOms.detail.providerOpsDeadline", { value: formatDate(sla.deadlineAt, locale) }) : null,
          typeof sla?.remainingOperationalMinutes === "number"
            ? t("admin:adminOms.detail.providerOpsRemaining", { count: sla.remainingOperationalMinutes })
            : null,
        ]).join(" · ")}
      </p>
    </div>
  );
}
