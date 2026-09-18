import { ShieldCheck } from "lucide-react";
import { useTranslation } from "react-i18next";

import type { CustomerDeliveryAlignment } from "@/domains/customers/accountV2Contracts";
import { formatDayMonth, type AccountLang } from "../lib/format";

/** Customer-facing explanation of a server-owned delivery-alignment fact. */
export function DeliveryAlignmentBanner({
  alignment,
  lang,
  nextCycleAt,
}: {
  alignment: CustomerDeliveryAlignment;
  lang: AccountLang;
  nextCycleAt: string | null;
}) {
  const { t } = useTranslation("account");
  const nextCycleLabel = formatDayMonth(nextCycleAt, lang);
  const title = alignment.state === "protected"
    ? t("account:dashboard.subscriptionV2.deliveryAlignment.protected.title")
    : t("account:dashboard.subscriptionV2.deliveryAlignment.aligned.title");
  const body = alignment.state === "protected"
    ? t("account:dashboard.subscriptionV2.deliveryAlignment.protected.body", { date: nextCycleLabel })
    : t("account:dashboard.subscriptionV2.deliveryAlignment.aligned.body", { date: nextCycleLabel });

  return (
    <div role="status" className="flex flex-col gap-3 rounded-control border border-teal/20 bg-teal/5 px-4 py-3 sm:flex-row sm:items-center sm:justify-between">
      <div className="flex min-w-0 gap-3">
        <ShieldCheck size={18} className="mt-0.5 shrink-0 text-teal-dark" aria-hidden />
        <div>
          <p className="text-sm font-semibold text-foreground">{title}</p>
          <p className="mt-0.5 text-sm text-foreground/65">{body}</p>
        </div>
      </div>
    </div>
  );
}
