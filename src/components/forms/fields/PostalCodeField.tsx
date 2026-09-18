import type { ReactNode } from "react";
import { useWatch, type Control, type FieldPath, type FieldValues } from "react-hook-form";
import { useTranslation } from "react-i18next";
import { isSupportedCountryIso, normalizeCountryIso, type SupportedCountryIsoCode } from "@/lib/schemas/fields";
import { BaseTextField } from "./BaseTextField";

export interface PostalCodeFieldProps<TFieldValues extends FieldValues, TContext = unknown, TTransformedValues = TFieldValues> {
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

export function PostalCodeField<TFieldValues extends FieldValues, TContext = unknown, TTransformedValues = TFieldValues>({
  control,
  countryName,
  label,
  placeholder,
  ...props
}: PostalCodeFieldProps<TFieldValues, TContext, TTransformedValues>) {
  const { t } = useTranslation("forms");
  const country = useWatch({ control, name: countryName });
  const normalizedCountry = normalizeCountryIso(country);
  const countryIso = isSupportedCountryIso(normalizedCountry) ? normalizedCountry : null;

  return (
    <BaseTextField
      {...props}
      autoComplete="postal-code"
      control={control}
      inputMode="text"
      label={label ?? t("forms:fields.postalCode.label")}
      placeholder={placeholder ?? postalCodePlaceholderForCountry(countryIso, t("forms:fields.postalCode.placeholder"))}
    />
  );
}

function postalCodePlaceholderForCountry(countryIso: SupportedCountryIsoCode | null, fallback: string): string {
  switch (countryIso) {
    case "DE":
      return "10115";
    case "FR":
      return "75001";
    case "GB":
      return "SW1A 1AA";
    case "PL":
      return "00-001";
    case "US":
      return "90210";
    default:
      return fallback;
  }
}
