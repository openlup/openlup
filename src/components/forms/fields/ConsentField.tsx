import type { ReactNode } from "react";
import type { Control, FieldPath, FieldValues } from "react-hook-form";
import { useTranslation } from "react-i18next";
import {
  FormControl,
  FormField,
  FormItem,
  FormMessage,
} from "@/components/ui/form";
import { cn } from "@/lib/utils";
import { ConsentCheckbox } from "./ConsentCheckbox";

export interface ConsentFieldProps<TFieldValues extends FieldValues, TContext = unknown, TTransformedValues = TFieldValues> {
  control: Control<TFieldValues, TContext, TTransformedValues>;
  name: FieldPath<TFieldValues>;
  label?: ReactNode;
  description?: ReactNode;
  required?: boolean;
  disabled?: boolean;
  className?: string;
  checkboxClassName?: string;
  tone?: "default" | "dark";
}

export function ConsentField<TFieldValues extends FieldValues, TContext = unknown, TTransformedValues = TFieldValues>({
  control,
  name,
  label,
  description,
  required,
  disabled,
  className,
  checkboxClassName,
  tone,
}: ConsentFieldProps<TFieldValues, TContext, TTransformedValues>) {
  const { t } = useTranslation("forms");

  return (
    <FormField
      control={control}
      name={name}
      render={({ field }) => (
        <FormItem className={cn("space-y-2", className)}>
          <FormControl>
            <ConsentCheckbox
              checked={field.value === true}
              className={checkboxClassName}
              description={description}
              disabled={disabled}
              label={label ?? t("forms:fields.consent.label")}
              onCheckedChange={(checked) => field.onChange(checked)}
              required={required}
              tone={tone}
            />
          </FormControl>
          <FormMessage />
        </FormItem>
      )}
    />
  );
}
