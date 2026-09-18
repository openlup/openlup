import type { ReactNode } from "react";
import type { Control, FieldPath, FieldValues } from "react-hook-form";
import { useTranslation } from "react-i18next";
import { BaseTextField } from "./BaseTextField";

export interface EmailFieldProps<TFieldValues extends FieldValues, TContext = unknown, TTransformedValues = TFieldValues> {
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

export function EmailField<TFieldValues extends FieldValues, TContext = unknown, TTransformedValues = TFieldValues>({
  autoComplete = "email",
  label,
  placeholder,
  ...props
}: EmailFieldProps<TFieldValues, TContext, TTransformedValues>) {
  const { t } = useTranslation("forms");

  return (
    <BaseTextField
      autoComplete={autoComplete}
      label={label ?? t("forms:fields.email.label")}
      placeholder={placeholder ?? t("forms:fields.email.placeholder")}
      type="email"
      {...props}
    />
  );
}
