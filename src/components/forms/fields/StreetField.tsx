import type { ReactNode } from "react";
import type { Control, FieldPath, FieldValues } from "react-hook-form";
import { useTranslation } from "react-i18next";
import { BaseTextField } from "./BaseTextField";

export interface StreetFieldProps<TFieldValues extends FieldValues, TContext = unknown, TTransformedValues = TFieldValues> {
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

export function StreetField<TFieldValues extends FieldValues, TContext = unknown, TTransformedValues = TFieldValues>({
  label,
  placeholder,
  ...props
}: StreetFieldProps<TFieldValues, TContext, TTransformedValues>) {
  const { t } = useTranslation("forms");

  return (
    <BaseTextField
      {...props}
      autoComplete="street-address"
      label={label ?? t("forms:fields.street.label")}
      placeholder={placeholder ?? t("forms:fields.street.placeholder")}
    />
  );
}
