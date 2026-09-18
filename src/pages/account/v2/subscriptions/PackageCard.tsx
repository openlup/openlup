import { useTranslation } from "react-i18next";
import { Pencil } from "lucide-react";

import {
  addonLines,
  recipeLines,
  type Pet,
  type Subscription,
} from "../lib/subscriptionEditModel";
import { flavourView } from "../lib/flavour";
import type { AccountLang } from "../lib/format";
import { formatDayMonth } from "../lib/format";
import { AccountCard, CoralButton, Eyebrow, SectionTitle } from "../ui/atoms";
import { CanChip } from "./CanChip";
import { FlavourMixBar, type MixSegment } from "./FlavourMixBar";

/**
 * PackageCard — the visual "what's in the box": recipe + add-on chips, the
 * flavour proportion bar, cans/cadence summary and the edit-window note.
 */
export function PackageCard({
  subscription,
  pet,
  lang,
  canEdit,
  blockedReasonKey,
  notActive = false,
  onEdit,
}: {
  subscription: Subscription;
  pet: Pet | null;
  lang: AccountLang;
  canEdit: boolean;
  blockedReasonKey?: string | null;
  notActive?: boolean;
  onEdit: () => void;
}) {
  const { t } = useTranslation("account");
  const breed = pet?.breed ?? null;

  const recipes = recipeLines(subscription);
  const addons = addonLines(subscription);
  const cans = recipes.reduce((sum, line) => sum + line.qty, 0);

  const segments: MixSegment[] = recipes.map((line) => {
    const view = flavourView(line.flavourSlug ?? line.productSlug ?? line.recipeName ?? line.title, breed, lang);
    return {
      label: line.displayLabel ?? view.label ?? line.title ?? "",
      qty: line.qty,
      color: line.accentColor ?? view.color,
    };
  });

  return (
    <AccountCard className="p-6 sm:p-7">
      <div className="flex items-start justify-between gap-4">
        <div>
          <Eyebrow>{t("account:dashboard.subscriptionV2.package.eyebrow")}</Eyebrow>
          <SectionTitle className="mt-1 text-2xl">
            {t("account:dashboard.subscriptionV2.package.title")}
          </SectionTitle>
        </div>
        <CoralButton
          icon={<Pencil size={16} />}
          onClick={onEdit}
          disabled={!canEdit}
          aria-describedby={!canEdit && blockedReasonKey ? "subscription-package-blocked" : undefined}
        >
          {t("account:dashboard.subscriptionV2.package.edit")}
        </CoralButton>
      </div>
      {!canEdit && blockedReasonKey ? (
        <p id="subscription-package-blocked" className="mt-3 rounded-control bg-warm-amber/10 px-4 py-3 text-sm text-foreground/70">
          {t(blockedReasonKey)}
        </p>
      ) : null}

      <div className="mt-6 flex flex-wrap gap-4">
        {recipes.map((line) => {
          const view = flavourView(line.flavourSlug ?? line.productSlug ?? line.recipeName ?? line.title, breed, lang);
          return (
            <CanChip
              key={line.lineId}
              image={view.image}
              label={line.displayLabel ?? view.label ?? line.title ?? ""}
              qty={line.qty}
              color={line.accentColor ?? view.color}
            />
          );
        })}
        {addons.map((line) => (
          <CanChip
            key={line.lineId}
            image={null}
            label={line.title ?? line.recipeName ?? ""}
            qty={line.qty}
            addon
          />
        ))}
      </div>

      {segments.length > 0 ? (
        <div className="mt-6">
          <FlavourMixBar segments={segments} />
        </div>
      ) : null}

      <p className="mt-5 text-sm font-semibold text-foreground">
        {t("account:dashboard.subscriptionV2.package.summary", {
          cans,
          days: subscription.cadenceDays,
        })}
      </p>

      <p className="mt-3 border-t border-teal-dark/8 pt-4 text-sm text-foreground/60">
        {notActive
          ? t(
              `account:dashboard.subscriptionV2.package.${
                subscription.status === "activation_failed"
                  ? "editWindowFailed"
                  : "editWindowPending"
              }`,
            )
          : subscription.editCutoffAt
            ? t("account:dashboard.subscriptionV2.package.editWindow", {
                date: formatDayMonth(subscription.editCutoffAt, lang),
              })
            : t("account:dashboard.subscriptionV2.package.editWindowClosed")}
      </p>
    </AccountCard>
  );
}
