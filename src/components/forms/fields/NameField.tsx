import type { ReactNode } from "react";
import type { Control, FieldPath, FieldValues } from "react-hook-form";
import { useTranslation } from "react-i18next";
import { BaseTextField } from "./BaseTextField";

export interface NameFieldProps<TFieldValues extends FieldValues, TContext = unknown, TTransformedValues = TFieldValues> {
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

export function NameField<TFieldValues extends FieldValues, TContext = unknown, TTransformedValues = TFieldValues>({
  autoComplete = "name",
  label,
  placeholder,
  ...props
}: NameFieldProps<TFieldValues, TContext, TTransformedValues>) {
  const { t } = useTranslation("forms");

  return (
    <BaseTextField
      autoComplete={autoComplete}
      label={label ?? t("forms:fields.name.label")}
      placeholder={placeholder ?? t("forms:fields.name.placeholder")}
      type="text"
      {...props}
    />
  );
}
