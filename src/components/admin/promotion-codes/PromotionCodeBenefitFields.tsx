import { Input } from "@/components/ui/input";
import { useTranslation } from "react-i18next";
import { currencySymbol } from "@/lib/currency/formatMinor";
import { ambientSettlementProfile } from "@/lib/currency/platformCurrency";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

export interface BenefitFormState {
  productEnabled: boolean;
  productKind: "target_percentage" | "fixed_amount";
  productValue: string;
  shippingEnabled: boolean;
  shippingKind: "free_shipping" | "percentage" | "fixed_amount";
  shippingValue: string;
}

export function PromotionCodeBenefitFields({
  value,
  onChange,
}: {
  value: BenefitFormState;
  onChange: (next: BenefitFormState) => void;
}) {
  const { t, i18n } = useTranslation("admin");
  // The label carries the currency's own symbol rather than a translated one, so
  // both translations stay free of a market while rendering exactly the bytes they
  // rendered before - the symbol each language already used. Both money inputs in
  // this form share the label, hence one binding.
  const amountLabel = t("admin:adminPromotionCodes.benefits.amount", {
    currency: currencySymbol(ambientSettlementProfile.defaultCurrency, i18n.language),
  });
  const patch = (next: Partial<BenefitFormState>) => onChange({ ...value, ...next });

  return (
    <fieldset className="grid gap-4 rounded-card border border-warm-sand p-4">
      <legend className="px-1 font-display text-base font-semibold text-teal-dark">{t("admin:adminPromotionCodes.benefits.legend")}</legend>

      <div className="grid gap-3">
        <label className="flex items-center gap-2 text-sm text-teal-dark">
          <input
            type="checkbox"
            checked={value.productEnabled}
            onChange={(event) => patch({ productEnabled: event.target.checked })}
            className="size-4 accent-teal"
          />
          {t("admin:adminPromotionCodes.benefits.productToggle")}
        </label>
        {value.productEnabled && (
          <div className="grid gap-3 pl-6 sm:grid-cols-2">
            <Field label={t("admin:adminPromotionCodes.benefits.productType")}>
              <Select value={value.productKind} onValueChange={(kind) => patch({ productKind: kind as BenefitFormState["productKind"] })}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="target_percentage">{t("admin:adminPromotionCodes.benefits.targetPercentage")}</SelectItem>
                  <SelectItem value="fixed_amount">{t("admin:adminPromotionCodes.benefits.fixedAmount")}</SelectItem>
                </SelectContent>
              </Select>
            </Field>
            <Field label={value.productKind === "target_percentage" ? t("admin:adminPromotionCodes.benefits.discountPercent") : amountLabel}>
              <Input
                type="number"
                min="0.01"
                max={value.productKind === "target_percentage" ? "99.99" : undefined}
                step="0.01"
                value={value.productValue}
                onChange={(event) => patch({ productValue: event.target.value })}
              />
            </Field>
          </div>
        )}
      </div>

      <div className="grid gap-3 border-t border-warm-sand pt-4">
        <label className="flex items-center gap-2 text-sm text-teal-dark">
          <input
            type="checkbox"
            checked={value.shippingEnabled}
            onChange={(event) => patch({ shippingEnabled: event.target.checked })}
            className="size-4 accent-teal"
          />
          {t("admin:adminPromotionCodes.benefits.shippingToggle")}
        </label>
        {value.shippingEnabled && (
          <div className="grid gap-3 pl-6 sm:grid-cols-2">
            <Field label={t("admin:adminPromotionCodes.benefits.shippingType")}>
              <Select value={value.shippingKind} onValueChange={(kind) => patch({ shippingKind: kind as BenefitFormState["shippingKind"] })}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="free_shipping">{t("admin:adminPromotionCodes.labels.freeShipping")}</SelectItem>
                  <SelectItem value="percentage">{t("admin:adminPromotionCodes.benefits.percentage")}</SelectItem>
                  <SelectItem value="fixed_amount">{t("admin:adminPromotionCodes.benefits.fixedAmount")}</SelectItem>
                </SelectContent>
              </Select>
            </Field>
            {value.shippingKind !== "free_shipping" && (
              <Field label={value.shippingKind === "percentage" ? t("admin:adminPromotionCodes.benefits.discountPercent") : amountLabel}>
                <Input
                  type="number"
                  min="0.01"
                  max={value.shippingKind === "percentage" ? "99.99" : undefined}
                  step="0.01"
                  value={value.shippingValue}
                  onChange={(event) => patch({ shippingValue: event.target.value })}
                />
              </Field>
            )}
          </div>
        )}
      </div>
    </fieldset>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="grid gap-1 text-sm">
      <span className="text-text-muted">{label}</span>
      {children}
    </label>
  );
}
