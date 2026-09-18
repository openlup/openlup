import { useTranslation } from "react-i18next";
import { ArrowLeft, CircleAlert, Clock, PackageCheck } from "lucide-react";

import type { CustomerAccountV2Response } from "@/domains/customers/accountV2Contracts";
import type { AccountConfiguratorSeed } from "@/domains/subscription/accountConfiguratorSeedContracts";
import type { SubscriptionSlotState } from "../lib/subscriptionSlotState";
import { AccountCard, CoralButton, Eyebrow, GhostButton, SectionTitle } from "../ui/atoms";

type AccountPet = CustomerAccountV2Response["pets"][number];

const STALE_DAYS = 90;
const DAY_MS = 24 * 60 * 60 * 1000;

function dataAgeDays(pet: AccountPet): number {
  const updated = Date.parse(pet.updatedAt);
  if (Number.isNaN(updated)) return 0;
  return Math.max(0, Math.round((Date.now() - updated) / DAY_MS));
}

export interface ConfirmPetDataProps {
  pet: AccountPet;
  seed: AccountConfiguratorSeed;
  /**
   * The subject's real slot state, so the one-time note names it instead of
   * calling every occupied slot "active". Omitted ⇒ the note falls back to the
   * running wording, which is what the single sentence used to say.
   */
  slot?: SubscriptionSlotState;
  onBack: () => void;
  onConfirm: () => void;
  /** Account-only: enter the payment-repair funnel for THIS subscription. */
  onRepairPayment?: (subscriptionId: string | null) => void;
}

/**
 * Review gate before pricing: account pet data can be stale, and weight/age
 * drive the portion size. The customer confirms (or learns they must adjust in
 * Step 1) before we compute the package.
 */
export function ConfirmPetData({
  pet,
  seed,
  slot,
  onBack,
  onConfirm,
  onRepairPayment,
}: ConfirmPetDataProps) {
  const { t } = useTranslation(["checkout", "account"]);
  const stale = dataAgeDays(pet) >= STALE_DAYS;
  const staleMonths = Math.round(dataAgeDays(pet) / 30);

  // Show the COERCED values that actually size the package (not the raw
  // free-text account fields), so what the customer confirms == what we price.
  const facts = [
    { key: "weight", value: pet.weightKg != null ? `${pet.weightKg} kg` : "–", highlight: stale },
    {
      key: "age",
      value: seed.form.dogAge
        ? t(`checkout:step1.ageOptions.${seed.form.dogAge}`)
        : pet.ageLabel ?? "–",
      highlight: stale || !seed.form.dogAge,
    },
    { key: "activity", value: t(`checkout:step1.activityOptions.${seed.form.activityLevel}`) },
    { key: "bcs", value: t(`checkout:step1.bcsOptions.${seed.form.bcs}`) },
  ];

  return (
    <div>
      <button
        type="button"
        onClick={onBack}
        className="focus-ring mb-3 inline-flex items-center gap-1.5 text-sm font-semibold text-foreground/55 hover:text-foreground"
      >
        <ArrowLeft size={15} aria-hidden /> {t("account:order.confirm.back")}
      </button>

      <SectionTitle as="h1" className="text-2xl">
        {t("account:order.confirm.title", { pet: pet.name })}
      </SectionTitle>
      <p className="mt-1 mb-5 text-sm text-foreground/60">{t("account:order.confirm.subtitle")}</p>

      {seed.hasActiveSubscriptionForSubject ? (
        // ⛔ The note names the REAL state. A paused subscription, and one stopped
        // by a failed charge, used to read as "aktywny pakiet" here.
        <div className="mb-4 flex items-start gap-2.5 rounded-card border border-teal/30 bg-teal/8 px-4 py-3">
          <PackageCheck size={18} className="mt-px shrink-0 text-teal-dark" aria-hidden />
          <div className="text-sm text-teal-dark">
            <p>
              {t(`account:order.confirm.oneTimeNote.${slot?.kind ?? "running"}`, {
                name: pet.name,
              })}
            </p>
            {/* The last screen before money is spent on a top-up while the
                subscription itself is unpaid or uncollected. */}
            {slot?.destination === "repair" && onRepairPayment ? (
              <button
                type="button"
                onClick={() => onRepairPayment(slot.subscriptionId)}
                className="focus-ring mt-1.5 font-semibold underline underline-offset-2"
              >
                {t(
                  slot.kind === "activation_unpaid"
                    ? "account:order.card.cta.finishPayment"
                    : "account:order.card.cta.repair",
                )}
              </button>
            ) : null}
          </div>
        </div>
      ) : null}

      {stale ? (
        <div className="mb-4 flex items-start gap-2.5 rounded-card border border-warm-amber/40 bg-warm-amber/10 px-4 py-3">
          <Clock size={18} className="mt-px shrink-0 text-copper" aria-hidden />
          <p className="text-sm text-copper">
            {t("account:order.confirm.stale", { pet: pet.name, months: staleMonths })}
          </p>
        </div>
      ) : null}

      <AccountCard className="p-5 sm:p-6">
        <div className="grid gap-3 sm:grid-cols-2">
          {facts.map((fact) => (
            <div
              key={fact.key}
              className={`rounded-control px-4 py-3 ${fact.highlight ? "bg-warm-amber/10" : "bg-teal/4"}`}
            >
              <p className="label-text text-foreground/45">{t(`account:order.confirm.field.${fact.key}`)}</p>
              <p className="font-body text-base font-bold text-foreground">{fact.value}</p>
            </div>
          ))}
        </div>

        <div className="mt-5 border-t border-teal-dark/8 pt-4">
          <Eyebrow className="text-foreground/45">{t("account:order.confirm.allergiesTitle")}</Eyebrow>
          {seed.form.allergens.length === 0 && seed.unrecognizedAllergies.length === 0 ? (
            <p className="mt-2 text-sm text-foreground/55">{t("account:order.confirm.noAllergies")}</p>
          ) : (
            <div className="mt-2 flex flex-wrap items-center gap-2">
              {seed.form.allergens.map((slug) => (
                <span
                  key={slug}
                  className="inline-flex items-center rounded-full bg-teal/10 px-3 py-1.5 text-sm-plus font-semibold text-teal-dark"
                >
                  {t(`checkout:allergens.${slug}`)}
                </span>
              ))}
              {seed.unrecognizedAllergies.map((raw) => (
                <span
                  key={raw}
                  className="inline-flex items-center gap-1.5 rounded-full bg-warm-coral/10 px-3 py-1.5 text-sm-plus font-semibold text-warm-coral"
                >
                  <CircleAlert size={13} aria-hidden /> {raw}
                </span>
              ))}
              {seed.unrecognizedAllergies.length > 0 ? (
                <span className="text-xs-plus text-foreground/55">
                  {t("account:order.confirm.unrecognizedHint")}
                </span>
              ) : null}
            </div>
          )}
        </div>
      </AccountCard>

      <div className="mt-5 flex items-center gap-3">
        <CoralButton onClick={onConfirm}>{t("account:order.confirm.cta")}</CoralButton>
        <span className="text-xs-plus text-foreground/50">{t("account:order.confirm.editHint")}</span>
      </div>
    </div>
  );
}
