import { MailCheck } from "lucide-react";
import type { TFunction } from "i18next";
import { AdminStatusPill } from "@/components/admin/AdminSurface";
import type { OmsOrderDetail } from "@/domains/commerce/omsContracts";
import { DetailSection } from "./OrderDetailBlocks";
import { formatDate } from "./ordersPageUtils";
import { compactParts } from "@/lib/utils";

export function CommunicationSection({ detail, locale, t }: { detail: OmsOrderDetail; locale: string; t: TFunction }) {
  return (
    <DetailSection
      testId="admin-oms-communication-section"
      icon={MailCheck}
      title={t("admin:adminOms.detail.communication")}
    >
      <div className="space-y-2">
        {detail.communicationDeliveries.length === 0 ? (
          <p className="text-sm text-text-muted">{t("admin:adminOms.detail.noCommunication")}</p>
        ) : (
          detail.communicationDeliveries.map((delivery) => (
            <div key={delivery.id} className="rounded-md border border-warm-sand bg-offwhite px-3 py-2">
              <div className="flex flex-wrap items-start justify-between gap-2">
                <div>
                  <p className="text-sm font-medium text-teal-dark">{delivery.templateSlug}</p>
                  <p className="text-xs text-text-muted">
                    {compactParts([
                      delivery.triggerEvent,
                      delivery.providerMessageId ? t("admin:adminOms.detail.providerId", { value: delivery.providerMessageId }) : null,
                      delivery.lastErrorCode ? t("admin:adminOms.detail.reasonCode", { value: delivery.lastErrorCode }) : null,
                    ]).join(" · ")}
                  </p>
                </div>
                <AdminStatusPill tone={communicationStatusTone(delivery.status)}>
                  {t(`admin:adminOms.communicationStatus.${delivery.status}`)}
                </AdminStatusPill>
              </div>
              <p className="mt-2 text-xs text-text-muted">
                {compactParts([
                  delivery.scheduledDueAt ? t("admin:adminOms.detail.scheduledAt", { value: formatDate(delivery.scheduledDueAt, locale) }) : null,
                  delivery.expectedSendAt ? t("admin:adminOms.detail.expectedAt", { value: formatDate(delivery.expectedSendAt, locale) }) : null,
                  delivery.sentAt ? t("admin:adminOms.detail.sentAt", { value: formatDate(delivery.sentAt, locale) }) : null,
                  delivery.deliveredAt ? t("admin:adminOms.detail.deliveredAt", { value: formatDate(delivery.deliveredAt, locale) }) : null,
                  delivery.terminalAt && !delivery.deliveredAt ? t("admin:adminOms.detail.terminalAt", { value: formatDate(delivery.terminalAt, locale) }) : null,
                ]).join(" · ")}
              </p>
            </div>
          ))
        )}
      </div>
    </DetailSection>
  );
}

// Delivery status -> the shared pill's tone. The class strings this replaced had drifted
// onto a dark-theme red (`text-red-200` on a white card), so the failure states were the
// hardest ones on the panel to read.
function communicationStatusTone(
  status: OmsOrderDetail["communicationDeliveries"][number]["status"],
): "teal" | "bad" | "warn" | "neutral" {
  if (status === "sent" || status === "delivered") return "teal";
  if (status === "failed" || status === "bounced" || status === "complained" || status === "missed") return "bad";
  if (status === "blocked" || status === "delivery_delayed") return "warn";
  return "neutral";
}
