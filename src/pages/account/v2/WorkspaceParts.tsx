import { useTranslation } from "react-i18next";
import { cn } from "@/lib/utils";

import {
  petForSubscription,
  type Pet,
  type Subscription,
} from "./lib/subscriptionEditModel";
import { AccountCard, CoralButton, Eyebrow, SectionTitle } from "./ui/atoms";
import type { AccountV2TabId } from "./AccountShell";

/** Placeholder for account tabs whose section UI hasn't shipped yet. */
export function SectionPlaceholder({ tab }: { tab: AccountV2TabId }) {
  const { t } = useTranslation("account");
  return (
    <AccountCard className="p-7">
      <Eyebrow>{t(`account:dashboard.shell.nav.${tab}`)}</Eyebrow>
      <SectionTitle className="mt-1 text-xl">{t(`account:dashboard.shell.nav.${tab}`)}</SectionTitle>
      <p className="mt-3 text-sm text-foreground/55">{t("account:dashboard.shell.comingSoon")}</p>
    </AccountCard>
  );
}

/**
 * Status-label key suffix for a switcher chip, or null for active subscriptions.
 * Mirrors the tone mapping used by the subscription screen badge so two chips
 * for the same pet (e.g. active + cancelled) stay tellable apart.
 */
function switcherStatusKey(status: Subscription["status"]): string | null {
  switch (status) {
    case "paused":
      return "paused";
    case "pending_activation":
      return "pending";
    case "activation_failed":
      return "failed";
    case "cancelled":
      return "cancelled";
    default:
      return null;
  }
}

/** Pet-name chips to switch the active subscription (rendered only for N > 1). */
export function SubscriptionSwitcher({
  subscriptions,
  pets,
  selectedId,
  onSelect,
}: {
  subscriptions: Subscription[];
  pets: Pet[];
  selectedId: string;
  onSelect: (id: string) => void;
}) {
  const { t } = useTranslation("account");
  if (subscriptions.length <= 1) return null;
  return (
    <div>
      <Eyebrow>{t("account:dashboard.subscriptionV2.switcherLabel")}</Eyebrow>
      <div className="mt-2 flex flex-wrap gap-2">
        {subscriptions.map((sub) => {
          const pet = petForSubscription(sub, pets);
          const active = sub.subscriptionId === selectedId;
          const statusKey = switcherStatusKey(sub.status);
          return (
            <button
              key={sub.subscriptionId}
              type="button"
              onClick={() => onSelect(sub.subscriptionId)}
              aria-pressed={active}
              className={cn(
                "focus-ring rounded-full border px-4 py-2 text-sm font-medium transition-colors",
                active
                  ? "border-teal bg-teal/10 text-foreground"
                  : "border-teal-dark/12 text-foreground/70 hover:border-teal",
              )}
            >
              {pet?.name ?? sub.subscriptionId.slice(0, 6)}
              {statusKey ? (
                <span className="text-foreground/60">
                  {" · "}
                  {t(`account:dashboard.subscriptionV2.status.${statusKey}`)}
                </span>
              ) : null}
            </button>
          );
        })}
      </div>
    </div>
  );
}

/**
 * Empty state when the customer has no subscription. CTA opens the in-account
 * order flow when enabled; otherwise it falls back to the public configurator.
 */
export function EmptySubscription({
  greetingName,
  onStartOrder,
}: {
  greetingName: string;
  onStartOrder?: () => void;
}) {
  const { t } = useTranslation("account");
  return (
    <div className="space-y-5">
      {greetingName ? (
        <SectionTitle as="h1" className="text-3xl">
          {t("account:dashboard.greetingNamed", { name: greetingName })}
        </SectionTitle>
      ) : null}
      <AccountCard className="flex flex-col items-start gap-3 p-8">
        <SectionTitle className="text-xl">
          {t("account:dashboard.subscriptionV2.empty.title")}
        </SectionTitle>
        <p className="text-sm text-foreground/60">
          {t("account:dashboard.subscriptionV2.empty.body")}
        </p>
        <CoralButton onClick={onStartOrder ?? (() => window.location.assign("/skomponuj-pakiet"))}>
          {t("account:dashboard.subscriptionV2.empty.cta")}
        </CoralButton>
      </AccountCard>
    </div>
  );
}
