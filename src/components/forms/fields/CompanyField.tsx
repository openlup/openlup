import type { ReactNode } from "react";
import type { Control, FieldPath, FieldValues } from "react-hook-form";
import { useTranslation } from "react-i18next";
import { BaseTextField } from "./BaseTextField";

export interface CompanyFieldProps<TFieldValues extends FieldValues, TContext = unknown, TTransformedValues = TFieldValues> {
  control: Control<TFieldValues, TContext, TTransformedValues>;
  name: FieldPath<TFieldValues>;
  label?: ReactNode;
  placeholder?: string;
  description?: ReactNode;
  required?: boolean;
  disabled?: boolean;
  autoComplete?: string;
  className?: string;
  inputClassName?: string;
}

export function CompanyField<TFieldValues extends FieldValues, TContext = unknown, TTransformedValues = TFieldValues>({
  autoComplete = "organization",
  label,
  placeholder,
  ...props
}: CompanyFieldProps<TFieldValues, TContext, TTransformedValues>) {
  const { t } = useTranslation("forms");

  return (
    <BaseTextField
      autoComplete={autoComplete}
      label={label ?? t("forms:fields.company.label")}
      placeholder={placeholder ?? t("forms:fields.company.placeholder")}
      type="text"
      {...props}
    />
  );
}
