import { useTranslation } from "react-i18next";
import {
  Clock,
  CreditCard,
  ReceiptText,
  MapPin,
  Repeat,
  ShieldCheck,
  Truck,
  type LucideIcon,
} from "lucide-react";

import type { CustomerAccountV2Response } from "@/domains/customers/accountV2Contracts";
import type { Subscription } from "../lib/subscriptionEditModel";
import type { InFlightDelivery } from "../lib/orderFulfillment";
import { stepLabelKey } from "@/domains/fulfillment/statusMap";
import type { AccountLang } from "../lib/format";
import {
  formatWeekdayDayMonth,
  formatDayMonth,
  formatDeliveryWindowLong,
  formatShortWeekdayDayMonth,
} from "../lib/format";
import { estimateDeliveryWindow } from "@/domains/subscription/deliveryEstimate";
import { DELIVERY_DISPATCH_POLICY } from "#delivery-dispatch-policy";
import { money } from "../../DashboardPanelUtils";
import { AccountCard, SectionTitle } from "../ui/atoms";

type Address = CustomerAccountV2Response["addresses"][number];

// Known `method_kind` slugs that have a friendly label. `blik_payid`, `wallet`
// and `alias` are the reusable payment-method kinds (see methodRefs in the
// payment domain); `blik`/`transfer` cover one-time rails.
const KNOWN_PAYMENT_METHOD_KINDS = new Set([
  "blik",
  "blik_payid",
  "card",
  "transfer",
  "wallet",
  "alias",
]);

function paymentLabel(kind: string | null, t: (k: string) => string): string {
  const key = kind?.toLowerCase();
  if (key && KNOWN_PAYMENT_METHOD_KINDS.has(key)) {
    return t(`account:dashboard.subscriptionV2.paymentMethod.${key}`);
  }
  return t("account:dashboard.subscriptionV2.paymentMethod.fallback");
}

function formatAddress(address: Address | null): string | null {
  if (!address) return null;
  return [address.line1, address.city].filter(Boolean).join(", ");
}

export function PlanFacts({
  subscription,
  address,
  lang,
  inFlight = null,
}: {
  subscription: Subscription;
  address: Address | null;
  lang: AccountLang;
  inFlight?: InFlightDelivery | null;
}) {
  const { t } = useTranslation("account");
  // `nextCycleAt` is the charge instant; the delivery row shows the estimated
  // window derived from it, and the charge date moved into the payment row.
  const delivery = subscription.nextCycleAt
    ? estimateDeliveryWindow(subscription.nextCycleAt, DELIVERY_DISPATCH_POLICY)
    : null;

  const rows: Array<{ icon: LucideIcon; label: string; value: string }> = [
    {
      icon: Repeat,
      label: t("account:dashboard.subscriptionV2.facts.frequency"),
      value: t("account:dashboard.subscriptionV2.facts.frequencyValue", {
        days: subscription.cadenceDays,
      }),
    },
    {
      icon: Truck,
      label: t("account:dashboard.subscriptionV2.facts.estimatedDelivery"),
      // With an in-flight first delivery, the nearest box is shown at its real
      // fulfilment stage (Przyjęte/Przygotowanie/…); `nextCycleAt` is surfaced
      // separately below as the next renewal charge.
      value: inFlight
        ? t(stepLabelKey(inFlight.step))
        : formatDeliveryWindowLong(delivery, lang),
    },
    ...(inFlight
      ? [
          {
            icon: Repeat,
            label: t("account:dashboard.subscriptionV2.facts.nextRenewal"),
            value: formatWeekdayDayMonth(subscription.nextCycleAt, lang),
          },
        ]
      : []),
    {
      icon: CreditCard,
      label: t("account:dashboard.subscriptionV2.facts.payment"),
      value: t("account:dashboard.subscriptionV2.facts.paymentValue", {
        date: formatDayMonth(subscription.nextCycleAt, lang),
        method: paymentLabel(subscription.paymentMethodKind, t),
      }),
    },
    // The stored method's own health, straight from the payload. Rendered only
    // when the read model actually resolved a status, so a subscription whose
    // status is unknown shows no row rather than a reassuring guess.
    ...(subscription.paymentMethodStatus
      ? [
          {
            icon: ShieldCheck,
            label: t("account:dashboard.subscriptionV2.facts.methodStatus"),
            value: t(
              `account:dashboard.subscriptionV2.facts.methodStatusValue.${subscription.paymentMethodStatus}`,
            ),
          },
        ]
      : []),
    {
      icon: Clock,
      label: t("account:dashboard.subscriptionV2.facts.editCutoff"),
      value: formatShortWeekdayDayMonth(subscription.editCutoffAt, lang),
    },
    {
      icon: ReceiptText,
      label: t("account:dashboard.subscriptionV2.facts.price"),
      value: subscription.recurringPrice
        ? t("account:dashboard.subscriptionV2.facts.priceValue", {
            price: money(subscription.recurringPrice.totalGross, lang),
            days: subscription.cadenceDays,
          })
        : t("account:dashboard.subscriptionV2.facts.priceFallback"),
    },
    {
      icon: MapPin,
      label: t("account:dashboard.subscriptionV2.facts.address"),
      value:
        formatAddress(address) ??
        t("account:dashboard.subscriptionV2.facts.addressFallback"),
    },
  ];

  return (
    <AccountCard className="p-6 sm:p-7">
      <SectionTitle className="text-xl">
        {t("account:dashboard.subscriptionV2.facts.title")}
      </SectionTitle>
      <dl className="mt-4 divide-y divide-teal-dark/8">
        {rows.map(({ icon: Icon, label, value }) => (
          <div key={label} className="flex items-start justify-between gap-4 py-3">
            <dt className="flex items-center gap-2 text-sm text-foreground/65">
              <Icon size={16} className="shrink-0 text-teal" />
              {label}
            </dt>
            <dd className="text-right text-sm font-semibold text-foreground">{value}</dd>
          </div>
        ))}
      </dl>
    </AccountCard>
  );
}
