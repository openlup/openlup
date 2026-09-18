import type { ReactNode } from "react";
import type { Control, FieldPath, FieldValues } from "react-hook-form";
import { useTranslation } from "react-i18next";
import { BaseTextField } from "./BaseTextField";

export interface CityFieldProps<TFieldValues extends FieldValues, TContext = unknown, TTransformedValues = TFieldValues> {
  control: Control<TFieldValues, TContext, TTransformedValues>;
  name: FieldPath<TFieldValues>;
  label?: ReactNode;
  placeholder?: string;
  description?: ReactNode;
  required?: boolean;
  disabled?: boolean;
  className?: string;
  inputClassName?: string;
}

export function CityField<TFieldValues extends FieldValues, TContext = unknown, TTransformedValues = TFieldValues>({
  label,
  placeholder,
  ...props
}: CityFieldProps<TFieldValues, TContext, TTransformedValues>) {
  const { t } = useTranslation("forms");

  return (
    <BaseTextField
      {...props}
      autoComplete="address-level2"
      label={label ?? t("forms:fields.city.label")}
      placeholder={placeholder ?? t("forms:fields.city.placeholder")}
    />
  );
}
