import { useTranslation } from "react-i18next";
import { CalendarClock } from "lucide-react";
import type { CustomerAccountV2Response } from "@/domains/customers/accountV2Contracts";
import {
  recipeLines,
  type Pet,
  type Subscription,
} from "../lib/subscriptionEditModel";
import type { AccountLang } from "../lib/format";
import { selectInFlightDelivery } from "../lib/orderFulfillment";
import { subscriptionActionAvailability } from "../lib/subscriptionActionAvailability";
import {
  AccountCard,
  CoralButton,
  Eyebrow,
  GhostButton,
  SectionTitle,
  StatusBadge,
  type SubscriptionStatusTone,
} from "../ui/atoms";
import { PackageCard } from "./PackageCard";
import { SubscriptionHeaderSchedule } from "./SubscriptionHeaderSchedule";
import { DeliveryTimeline } from "./DeliveryTimeline";
import { PlanFacts } from "./PlanFacts";
import { AddonsCard } from "./AddonsCard";
import { DeliveryAlignmentBanner } from "./DeliveryAlignmentBanner";
import { ActionRequiredBanner } from "../start/ActionRequiredBanner";
import { selectExpiredArrears, selectSubscriptionArrears } from "../lib/dunningFacts";
import { hasPaidSubscriptionActivationGap } from "@/domains/customers/accountActionRequiredContracts";
export interface SubscriptionActions {
  onEdit: () => void;
  onReschedule: () => void;
  onSkip: () => void;
  onPause: () => void;
  onResume: () => void;
  onCancel: () => void;
  onManageAddons: () => void;
  onReactivate: () => void;
  onOrderNow: () => void;
  onChangeAddress: () => void;
  /** W5: complete payment for an unpaid (pending_activation) subscription order. */
  onCompletePayment: () => void;
  /** Start payment recovery for this subscription. */
  onRepair: () => void;
}
const PAYMENT_BLOCKERS = new Set(["payment_blocked", "missing_payment_method"]);
const STATUS_TONES: Partial<Record<Subscription["status"], SubscriptionStatusTone>> = {
  paused: "paused",
  pending_activation: "pending",
  activation_failed: "failed",
  cancelled: "cancelled",
};
function subscriptionTone(subscription: Subscription, paymentBlocked: boolean): SubscriptionStatusTone {
  // A recovery case, open or expired, outranks `paused`: the customer must see
  // why the subscription stopped, not a neutral "paused" they never chose.
  if (paymentBlocked) return "blocked";
  const blocker = subscription.editBlockedReason;
  if (blocker && PAYMENT_BLOCKERS.has(blocker)) return "blocked";
  return STATUS_TONES[subscription.status] ?? "active";
}
function PetAvatar({ pet, size = 44 }: { pet: Pet | null; size?: number }) {
  const style = { width: size, height: size };
  if (pet?.photoUrl) {
    return <img src={pet.photoUrl} alt="" style={style} className="rounded-full object-cover" />;
  }
  return (
    <span
      style={style}
      className="grid place-items-center rounded-full bg-teal/15 font-display font-semibold text-teal-dark"
    >
      {(pet?.name ?? "·").charAt(0).toUpperCase()}
    </span>
  );
}
export function SubscriptionScreen({
  account,
  subscription,
  pet,
  lang,
  actions,
}: {
  account: CustomerAccountV2Response;
  subscription: Subscription;
  pet: Pet | null;
  lang: AccountLang;
  actions: SubscriptionActions;
}) {
  const { t } = useTranslation("account");
  const arrears = selectSubscriptionArrears(account, subscription);
  const expired = selectExpiredArrears(account, subscription);
  const gate = { paymentBlocked: arrears !== null, paymentExpired: expired !== null };
  const banner = arrears ?? expired;
  const tone = subscriptionTone(subscription, banner !== null);
  const cans = recipeLines(subscription).reduce((sum, line) => sum + line.qty, 0);
  const editAvailability = subscriptionActionAvailability(subscription, "edit", gate);
  const rescheduleAvailability = subscriptionActionAvailability(subscription, "reschedule", gate);
  const skipAvailability = subscriptionActionAvailability(subscription, "skip", gate);
  const orderNowAvailability = subscriptionActionAvailability(subscription, "order_now", gate);
  // One verdict covered pause and resume while a case was open. After it EXPIRES
  // they diverge (resume is the way out, pause is not), so the verdict is asked
  // for the action actually shown.
  const lifecycleAction = subscription.status === "paused" ? "resume" : "pause";
  const lifecycleAvailability = subscriptionActionAvailability(subscription, lifecycleAction, gate);
  // One note under the lifecycle controls. The recovery case outranks the
  // edit-window reason, because it is the one that also disables pause/resume.
  const lifecycleNoteKey =
    lifecycleAvailability.reasonKey ??
    (orderNowAvailability.visible && !orderNowAvailability.enabled
      ? orderNowAvailability.reasonKey
      : null);
  const notActive =
    subscription.status === "pending_activation" ||
    subscription.status === "activation_failed";
  const paidActivationGap = hasPaidSubscriptionActivationGap(account.actionRequired, subscription.subscriptionId);
  const incompleteKey = paidActivationGap
    ? "paidMissingMandate"
    : subscription.status === "activation_failed" ? "failed" : "pending";
  const inFlight = notActive ? null : selectInFlightDelivery(account, subscription);
  const address =
    account.addresses.find((item) => item.addressId === subscription.shippingAddressId) ?? null;
  const petName = pet?.name ?? "";
  return (
    <div className="space-y-5">
      <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex items-center gap-4">
          <PetAvatar pet={pet} />
          <div>
            <SectionTitle as="h1" className="text-3xl">
              {t("account:dashboard.subscriptionV2.headerTitle", { pet: petName })}
            </SectionTitle>
            <div className="mt-1.5 flex flex-wrap items-center gap-2 text-sm text-foreground/60">
              <StatusBadge tone={tone}>
                {t(`account:dashboard.subscriptionV2.status.${tone}`)}
              </StatusBadge>
              <span>
                {t("account:dashboard.subscriptionV2.headerMeta", {
                  days: subscription.cadenceDays,
                  cans,
                })}
              </span>
            </div>
          </div>
        </div>
        <SubscriptionHeaderSchedule subscription={subscription} lang={lang} inFlight={inFlight} />
      </div>

      {banner ? (
        <ActionRequiredBanner
          petName={petName}
          arrears={banner}
          variant={arrears ? "open" : "expired"}
          methodStatus={subscription.paymentMethodStatus}
          lang={lang}
          onRepair={actions.onRepair}
          onResumeAfterExpired={actions.onResume}
        />
      ) : null}
      {subscription.deliveryAlignment && !notActive ? (
        <DeliveryAlignmentBanner
          alignment={subscription.deliveryAlignment}
          lang={lang}
          nextCycleAt={subscription.nextCycleAt}
        />
      ) : null}
      {notActive ? (
        <AccountCard className="border-warm-amber/30 bg-warm-amber/5 p-6 sm:p-7">
          <SectionTitle className="text-lg">{t(`account:dashboard.subscriptionV2.incomplete.${incompleteKey}.title`)}</SectionTitle>
          <p className="mt-2 text-sm leading-relaxed text-foreground/70">
            {t(`account:dashboard.subscriptionV2.incomplete.${incompleteKey}.body`)}
          </p>
          {subscription.status === "pending_activation" ? (
            <CoralButton className="mt-4" onClick={actions.onCompletePayment}>
              {t(`account:dashboard.subscriptionV2.incomplete.${incompleteKey}.cta`)}
            </CoralButton>
          ) : null}
        </AccountCard>
      ) : null}

      <PackageCard
        subscription={subscription}
        pet={pet}
        lang={lang}
        canEdit={editAvailability.enabled}
        blockedReasonKey={editAvailability.reasonKey}
        notActive={notActive}
        onEdit={actions.onEdit}
      />

      <div className="grid gap-5 lg:grid-cols-[minmax(0,1fr)_minmax(0,0.82fr)]">
        {notActive ? null : (
          <AccountCard className="p-6 sm:p-7">
            <div className="flex items-center justify-between gap-4">
              <div>
                <Eyebrow>{t("account:dashboard.subscriptionV2.schedule.eyebrow")}</Eyebrow>
                <SectionTitle className="mt-1 text-xl">
                  {t("account:dashboard.subscriptionV2.schedule.title")}
                </SectionTitle>
              </div>
              <GhostButton
                icon={<CalendarClock size={16} />}
                onClick={actions.onReschedule}
                disabled={!rescheduleAvailability.enabled}
                aria-describedby={!rescheduleAvailability.enabled && rescheduleAvailability.reasonKey ? "subscription-schedule-blocked" : undefined}
              >
                {t("account:dashboard.subscriptionV2.schedule.reschedule")}
              </GhostButton>
            </div>
            {!rescheduleAvailability.enabled && rescheduleAvailability.reasonKey ? (
              <p id="subscription-schedule-blocked" className="mt-4 rounded-control bg-warm-amber/10 px-4 py-3 text-sm text-foreground/70">
                {t(rescheduleAvailability.reasonKey)}
              </p>
            ) : null}
            <div className="mt-6">
              <DeliveryTimeline
                nextCycleAt={subscription.nextCycleAt}
                cadenceDays={subscription.cadenceDays}
                lang={lang}
                inFlight={inFlight}
                onSkip={skipAvailability.enabled ? actions.onSkip : undefined}
              />
            </div>
            <p className="mt-5 flex gap-2 border-t border-teal-dark/8 pt-4 text-sm text-foreground/55">
              {t("account:dashboard.subscriptionV2.schedule.note", {
                days: subscription.cadenceDays,
              })}
            </p>
          </AccountCard>
        )}

        <PlanFacts subscription={subscription} address={address} lang={lang} inFlight={inFlight} />
      </div>

      <div className="grid gap-5 lg:grid-cols-2">
        <AddonsCard
          subscription={subscription}
          canManage={editAvailability.enabled}
          blockedReasonKey={editAvailability.reasonKey}
          onManage={actions.onManageAddons}
        />

        {notActive ? null : (
          <AccountCard className="p-6 sm:p-7">
            <SectionTitle className="text-xl">
              {t("account:dashboard.subscriptionV2.lifecycle.title")}
            </SectionTitle>
            <div className="mt-4 flex flex-wrap gap-3">
              {subscription.status === "cancelled" ? (
                <CoralButton onClick={actions.onReactivate}>
                  {t("account:dashboard.subscriptionV2.lifecycle.reactivate")}
                </CoralButton>
              ) : (
                <>
                  <GhostButton
                    onClick={subscription.status === "paused" ? actions.onResume : actions.onPause}
                    disabled={!lifecycleAvailability.enabled}
                    aria-describedby={
                      lifecycleAvailability.enabled ? undefined : "subscription-lifecycle-blocked"
                    }
                  >
                    {t(
                      subscription.status === "paused"
                        ? "account:dashboard.subscriptionV2.lifecycle.resume"
                        : "account:dashboard.subscriptionV2.lifecycle.pause",
                    )}
                  </GhostButton>
                  {orderNowAvailability.visible ? (
                    <GhostButton
                      onClick={actions.onOrderNow}
                      disabled={!orderNowAvailability.enabled}
                      aria-describedby={lifecycleNoteKey ? "subscription-lifecycle-blocked" : undefined}
                    >
                      {t("account:dashboard.subscriptionV2.lifecycle.orderNow")}
                    </GhostButton>
                  ) : null}
                  <GhostButton onClick={actions.onChangeAddress}>
                    {t("account:dashboard.subscriptionV2.lifecycle.changeAddress")}
                  </GhostButton>
                  <GhostButton
                    onClick={actions.onCancel}
                    className="border-warm-coral/30 text-warm-coral hover:border-warm-coral"
                  >
                    {t("account:dashboard.subscriptionV2.lifecycle.cancel")}
                  </GhostButton>
                </>
              )}
            </div>
            {lifecycleNoteKey ? (
              <p id="subscription-lifecycle-blocked" className="mt-4 rounded-control bg-warm-amber/10 px-4 py-3 text-sm text-foreground/70">
                {t(lifecycleNoteKey)}
              </p>
            ) : null}
          </AccountCard>
        )}
      </div>
    </div>
  );
}
