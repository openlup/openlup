import type { ReactNode } from "react";
import type { Control, FieldPath, FieldValues } from "react-hook-form";
import { useTranslation } from "react-i18next";
import { BaseTextField } from "./BaseTextField";

export interface PasswordFieldProps<TFieldValues extends FieldValues, TContext = unknown, TTransformedValues = TFieldValues> {
  control: Control<TFieldValues, TContext, TTransformedValues>;
  name: FieldPath<TFieldValues>;
  label?: ReactNode;
  placeholder?: string;
  description?: ReactNode;
  required?: boolean;
  disabled?: boolean;
  autoComplete?: "current-password" | "new-password";
  className?: string;
  inputClassName?: string;
}

export function PasswordField<TFieldValues extends FieldValues, TContext = unknown, TTransformedValues = TFieldValues>({
  autoComplete = "current-password",
  label,
  placeholder,
  ...props
}: PasswordFieldProps<TFieldValues, TContext, TTransformedValues>) {
  const { t } = useTranslation("forms");

  return (
    <BaseTextField
      {...props}
      autoComplete={autoComplete}
      label={label ?? t("forms:fields.password.label")}
      placeholder={placeholder ?? t("forms:fields.password.placeholder")}
      type="password"
    />
  );
}
