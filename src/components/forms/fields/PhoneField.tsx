import type { ReactNode } from "react";
import { useWatch, type Control, type FieldPath, type FieldValues } from "react-hook-form";
import { useTranslation } from "react-i18next";
import { isSupportedCountryIso, normalizeCountryIso, type SupportedCountryIsoCode } from "@/lib/schemas/fields";
import { BaseTextField } from "./BaseTextField";

export interface PhoneFieldProps<TFieldValues extends FieldValues, TContext = unknown, TTransformedValues = TFieldValues> {
  control: Control<TFieldValues, TContext, TTransformedValues>;
  name: FieldPath<TFieldValues>;
  countryName: FieldPath<TFieldValues>;
  label?: ReactNode;
  placeholder?: string;
  description?: ReactNode;
  required?: boolean;
  disabled?: boolean;
  className?: string;
  inputClassName?: string;
}

export function PhoneField<TFieldValues extends FieldValues, TContext = unknown, TTransformedValues = TFieldValues>({
  control,
  countryName,
  label,
  placeholder,
  ...props
}: PhoneFieldProps<TFieldValues, TContext, TTransformedValues>) {
  const { t } = useTranslation("forms");
  const country = useWatch({ control, name: countryName });
  const normalizedCountry = normalizeCountryIso(country);
  const countryIso = isSupportedCountryIso(normalizedCountry) ? normalizedCountry : null;

  return (
    <BaseTextField
      {...props}
      autoComplete="tel"
      control={control}
      inputMode="tel"
      label={label ?? t("forms:fields.phone.label")}
      placeholder={placeholder ?? phonePlaceholderForCountry(countryIso, t("forms:fields.phone.placeholder"))}
      type="tel"
    />
  );
}

function phonePlaceholderForCountry(countryIso: SupportedCountryIsoCode | null, fallback: string): string {
  switch (countryIso) {
    case "DE":
      return "+49 30 123 456";
    case "FR":
      return "+33 1 23 45 67 89";
    case "GB":
      return "+44 20 7946 0958";
    case "PL":
      return "+48 123 456 789";
    case "US":
      return "+1 213 373 4253";
    default:
      return fallback;
  }
}
