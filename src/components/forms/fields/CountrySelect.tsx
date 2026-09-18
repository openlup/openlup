import type { ReactNode } from "react";
import type { Control, FieldPath, FieldValues } from "react-hook-form";
import { useTranslation } from "react-i18next";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  FormControl,
  FormDescription,
  FormField,
  FormItem,
  FormLabel,
  FormMessage,
} from "@/components/ui/form";
import {
  countryOptions,
  isSupportedCountryIso,
  legacyCountryLabelForIso,
  normalizeCountryIso,
  type CountryLabelLocale,
  type SupportedCountryIsoCode,
} from "@/lib/schemas/fields";

export type CountrySelectValueMode = "iso" | "legacyLabel";

export interface CountrySelectProps<TFieldValues extends FieldValues, TContext = unknown, TTransformedValues = TFieldValues> {
  control: Control<TFieldValues, TContext, TTransformedValues>;
  name: FieldPath<TFieldValues>;
  valueMode?: CountrySelectValueMode;
  legacyLocale?: CountryLabelLocale;
  displayLocale?: CountryLabelLocale;
  label?: ReactNode;
  placeholder?: string;
  description?: ReactNode;
  required?: boolean;
  disabled?: boolean;
  className?: string;
  triggerClassName?: string;
  contentClassName?: string;
}

export function CountrySelect<TFieldValues extends FieldValues, TContext = unknown, TTransformedValues = TFieldValues>({
  control,
  name,
  valueMode = "iso",
  legacyLocale,
  displayLocale,
  label,
  placeholder,
  description,
  required,
  disabled,
  className,
  triggerClassName,
  contentClassName,
}: CountrySelectProps<TFieldValues, TContext, TTransformedValues>) {
  const { i18n, t } = useTranslation("forms");
  const resolvedDisplayLocale = displayLocale ?? localeFromLanguage(i18n.resolvedLanguage ?? i18n.language);
  const resolvedLegacyLocale = legacyLocale ?? resolvedDisplayLocale;

  return (
    <FormField
      control={control}
      name={name}
      render={({ field }) => (
        <FormItem className={className}>
          <FormLabel required={required}>{label ?? t("forms:fields.country.label")}</FormLabel>
          <Select
            disabled={disabled}
            onValueChange={field.onChange}
            value={selectValueForFieldValue(field.value, valueMode, resolvedLegacyLocale)}
          >
            <FormControl>
              <SelectTrigger aria-required={required || undefined} className={triggerClassName}>
                <SelectValue placeholder={placeholder ?? t("forms:fields.country.placeholder")} />
              </SelectTrigger>
            </FormControl>
            <SelectContent className={contentClassName}>
              {countryOptions.map((option) => (
                <SelectItem key={option.iso} value={optionValue(option.iso, valueMode, resolvedLegacyLocale)}>
                  {option.label[resolvedDisplayLocale]}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          {description && <FormDescription>{description}</FormDescription>}
          <FormMessage />
        </FormItem>
      )}
    />
  );
}

function selectValueForFieldValue(
  fieldValue: unknown,
  valueMode: CountrySelectValueMode,
  legacyLocale: CountryLabelLocale,
): string {
  const iso = normalizeCountryIso(fieldValue);
  if (isSupportedCountryIso(iso)) return optionValue(iso, valueMode, legacyLocale);
  return typeof fieldValue === "string" ? fieldValue : "";
}

function optionValue(
  iso: SupportedCountryIsoCode,
  valueMode: CountrySelectValueMode,
  legacyLocale: CountryLabelLocale,
): string {
  if (valueMode === "legacyLabel") return legacyCountryLabelForIso(iso, legacyLocale) ?? iso;
  return iso;
}

function localeFromLanguage(language: string | undefined): CountryLabelLocale {
  return language?.toLowerCase().startsWith("pl") ? "pl" : "en";
}
