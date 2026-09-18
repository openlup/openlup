import type { TFunction } from "i18next";
import type { OmsOrderDetail } from "@/domains/commerce/omsContracts";
import { formatDate } from "./ordersPageUtils";
import { compactParts } from "@/lib/utils";

export function ProviderEvidence({
  evidence,
  locale,
  t,
}: {
  evidence: OmsOrderDetail["fulfillment"]["providerEvidence"];
  locale: string;
  t: TFunction;
}) {
  return (
    <div className="mt-4 space-y-2" data-testid="admin-oms-provider-evidence">
      <p className="text-xs font-semibold uppercase text-text-muted">{t("admin:adminOms.detail.providerEvidence")}</p>
      {evidence.length === 0 ? (
        <p className="text-sm text-text-muted">{t("admin:adminOms.detail.noProviderEvidence")}</p>
      ) : evidence.slice(0, 6).map((entry) => (
        <div key={`${entry.evidenceType}:${entry.providerOrderId ?? entry.status ?? entry.providerStatus ?? "pending"}:${entry.updatedAt ?? entry.occurredAt ?? "na"}`} className="rounded-md border border-warm-sand bg-white p-2 text-sm">
          <p className="font-medium text-teal-dark">
            {compactParts([entry.evidenceType, entry.status, entry.providerStatus]).join(" · ")}
          </p>
          <p className="text-xs text-text-muted">
            {compactParts([
              entry.evidenceKind,
              entry.providerOrderId ? `providerOrderId ${entry.providerOrderId}` : null,
              entry.summary,
              entry.updatedAt ? formatDate(entry.updatedAt, locale) : entry.occurredAt ? formatDate(entry.occurredAt, locale) : null,
            ]).join(" · ")}
          </p>
        </div>
      ))}
    </div>
  );
}
