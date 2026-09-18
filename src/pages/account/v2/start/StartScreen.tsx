import type { ReactNode } from "react";
import { useTranslation } from "react-i18next";

import type { CustomerAccountV2Response } from "@/domains/customers/accountV2Contracts";
import {
  dateLabel,
  enumLabel,
  money,
  orderDisplayRef,
} from "../../DashboardPanelUtils";
import type { Pet, Subscription } from "../lib/subscriptionEditModel";
import { selectInFlightDelivery } from "../lib/orderFulfillment";
import type { AccountLang } from "../lib/format";
import { AccountCard, CoralButton, Eyebrow, SectionTitle } from "../ui/atoms";
import { ShoppingBag } from "lucide-react";
import type { AccountV2TabId } from "../AccountShell";
import type { SubscriptionActions } from "../subscriptions/SubscriptionScreen";
import { StatusTiles } from "./StatusTiles";
import { DeliveryHero } from "./DeliveryHero";
import { ActionRequiredBanner } from "./ActionRequiredBanner";
import { selectExpiredArrears, selectSubscriptionArrears } from "../lib/dunningFacts";

const PAYMENT_BLOCKERS = new Set(["payment_blocked", "missing_payment_method"]);

export function StartScreen({
  account,
  subscription,
  pet,
  greetingName,
  lang,
  actions,
  onRepair,
  onSelectTab,
  onStartOrder,
  orderBlock,
}: {
  account: CustomerAccountV2Response;
  subscription: Subscription;
  pet: Pet | null;
  greetingName: string;
  lang: AccountLang;
  actions: SubscriptionActions;
  onRepair: () => void;
  onSelectTab: (tab: AccountV2TabId) => void;
  /** Open the in-account order flow (only set when the flag is on). */
  onStartOrder?: () => void;
  /**
   * The in-account ordering surface, rendered inline as one block of the
   * dashboard. When supplied it REPLACES the "Zamów nowy pakiet" card: the card
   * exists only to send the customer to that surface, so keeping both would offer
   * the same thing twice on one page.
   */
  orderBlock?: ReactNode;
}) {
  const { t } = useTranslation("account");
  const petName = pet?.name ?? "";
  // `editBlockedReason` alone cannot see this: it reads `not_active` for a
  // subscription paused during recovery. The open case is the truthful fact.
  const openArrears = selectSubscriptionArrears(account, subscription);
  // An expired case is the same red surface with a different promise: nothing
  // is retrying, and the way back is to update the method and resume.
  const arrears = openArrears ?? selectExpiredArrears(account, subscription);
  const blocked =
    arrears !== null ||
    (subscription.editBlockedReason ? PAYMENT_BLOCKERS.has(subscription.editBlockedReason) : false);
  const address =
    account.addresses.find((item) => item.addressId === subscription.shippingAddressId) ?? null;
  const recentOrder = account.recentOrders[0] ?? null;
  const inFlight = selectInFlightDelivery(account, subscription);

  return (
    <div className="space-y-5">
      <div>
        <SectionTitle as="h1" className="text-3xl">
          {greetingName
            ? t("account:dashboard.greetingNamed", { name: greetingName })
            : t("account:dashboard.greetingFallback")}
        </SectionTitle>
        <p className="mt-1 text-foreground/60">
          {t("account:dashboard.start.subtitle", { pet: petName })}
        </p>
      </div>

      {arrears ? (
        <ActionRequiredBanner
          petName={petName}
          arrears={arrears}
          variant={openArrears ? "open" : "expired"}
          methodStatus={subscription.paymentMethodStatus}
          lang={lang}
          onRepair={onRepair}
          onResumeAfterExpired={actions.onResume}
        />
      ) : null}

      {orderBlock ? (
        <AccountCard className="p-6 sm:p-7">{orderBlock}</AccountCard>
      ) : onStartOrder ? (
        <AccountCard className="flex flex-col gap-3 p-6 sm:flex-row sm:items-center sm:justify-between">
          <div>
            <Eyebrow className="text-warm-coral">{t("account:order.eyebrowReturning")}</Eyebrow>
            <SectionTitle className="mt-1 text-lg">
              {t("account:order.start.title")}
            </SectionTitle>
            <p className="mt-0.5 text-sm text-foreground/60">{t("account:order.start.body")}</p>
          </div>
          <CoralButton
            className="shrink-0"
            icon={<ShoppingBag size={16} aria-hidden />}
            onClick={onStartOrder}
          >
            {t("account:order.start.cta")}
          </CoralButton>
        </AccountCard>
      ) : null}

      <StatusTiles
        subscription={subscription}
        recentOrder={recentOrder}
        lang={lang}
        blocked={blocked}
        inFlight={inFlight}
        onSelectTab={onSelectTab}
        onRepair={onRepair}
      />

      <DeliveryHero
        subscription={subscription}
        pet={pet}
        address={address}
        lang={lang}
        actions={actions}
        inFlight={inFlight}
        onManage={() => onSelectTab("subscriptions")}
      />

      <div className="grid gap-5 lg:grid-cols-[minmax(0,1fr)_minmax(0,0.85fr)]">
        <AccountCard className="p-6 sm:p-7">
          <div className="flex items-center justify-between">
            <SectionTitle className="text-xl">
              {t("account:dashboard.start.recentOrders.title")}
            </SectionTitle>
            <button
              type="button"
              onClick={() => onSelectTab("orders")}
              className="focus-ring text-sm font-semibold text-teal hover:underline"
            >
              {t("account:dashboard.start.recentOrders.open")}
            </button>
          </div>
          {account.recentOrders.length === 0 ? (
            <p className="mt-3 text-sm text-foreground/55">
              {t("account:dashboard.start.recentOrders.empty")}
            </p>
          ) : (
            <ul className="mt-4 space-y-2">
              {account.recentOrders.slice(0, 3).map((order) => (
                <li
                  key={order.orderId}
                  className="flex items-center justify-between rounded-control border border-teal-dark/8 px-4 py-3"
                >
                  <span>
                    <span className="block text-sm font-semibold text-foreground">
                      {orderDisplayRef(order, t)}
                    </span>
                    <span className="text-xxs text-foreground/55">
                      {dateLabel(order.createdAt, lang, "–")}
                    </span>
                  </span>
                  <span className="text-sm font-bold text-foreground">
                    {money(order.total, lang)}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </AccountCard>

        <AccountCard className="p-6 sm:p-7">
          <SectionTitle className="text-xl">
            {t("account:dashboard.start.activity.title")}
          </SectionTitle>
          {account.events.length === 0 ? (
            <p className="mt-3 text-sm text-foreground/55">
              {t("account:dashboard.start.activity.empty")}
            </p>
          ) : (
            <ul className="mt-4 space-y-3">
              {account.events.slice(0, 5).map((event, index) => (
                <li key={`${event.eventType}-${index}`} className="flex items-start gap-3">
                  <span className="mt-1.5 h-2 w-2 shrink-0 rounded-full bg-teal" />
                  <span>
                    <span className="block text-sm text-foreground">
                      {enumLabel(t, "account:dashboard.panels.events.eventType", event.eventType)}
                    </span>
                    <span className="text-xxs text-foreground/55">
                      {dateLabel(event.occurredAt, lang, "–")}
                    </span>
                  </span>
                </li>
              ))}
            </ul>
          )}
        </AccountCard>
      </div>
    </div>
  );
}
