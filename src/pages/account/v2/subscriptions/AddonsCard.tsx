import { useTranslation } from "react-i18next";
import { Plus } from "lucide-react";

import {
  addonLines,
  type Subscription,
} from "../lib/subscriptionEditModel";
import { AccountCard, SectionTitle } from "../ui/atoms";

/**
 * Add-ons list (toppers / treats / supplements). Name + quantity only — no
 * prices. "Manage" opens the package editor (add-ons section).
 */
export function AddonsCard({
  subscription,
  canManage,
  blockedReasonKey,
  onManage,
}: {
  subscription: Subscription;
  canManage: boolean;
  blockedReasonKey?: string | null;
  onManage: () => void;
}) {
  const { t } = useTranslation("account");
  const addons = addonLines(subscription);

  return (
    <AccountCard className="p-6 sm:p-7">
      <div className="flex items-center justify-between gap-4">
        <SectionTitle className="text-xl">
          {t("account:dashboard.subscriptionV2.addons.title")}
        </SectionTitle>
        <button
          type="button"
          onClick={onManage}
          disabled={!canManage}
          aria-describedby={!canManage && blockedReasonKey ? "subscription-addons-blocked" : undefined}
          className="focus-ring text-sm font-semibold text-teal hover:underline disabled:pointer-events-none disabled:opacity-50"
        >
          {t("account:dashboard.subscriptionV2.addons.manage")}
        </button>
      </div>
      {!canManage && blockedReasonKey ? (
        <p id="subscription-addons-blocked" className="mt-3 rounded-control bg-warm-amber/10 px-4 py-3 text-sm text-foreground/70">
          {t(blockedReasonKey)}
        </p>
      ) : null}

      {addons.length === 0 ? (
        <p className="mt-3 text-sm text-foreground/55">
          {t("account:dashboard.subscriptionV2.addons.empty")}
        </p>
      ) : (
        <ul className="mt-4 space-y-2">
          {addons.map((line) => (
            <li
              key={line.lineId}
              className="flex items-center justify-between rounded-control border border-teal-dark/8 px-4 py-3"
            >
              <span className="flex items-center gap-2 text-sm font-semibold text-foreground">
                <span className="grid h-8 w-8 place-items-center rounded-full bg-copper/10 text-copper">
                  <Plus size={15} />
                </span>
                {line.title ?? line.recipeName ?? ""}
              </span>
              <span className="text-sm font-bold text-foreground">×{line.qty}</span>
            </li>
          ))}
        </ul>
      )}
    </AccountCard>
  );
}
