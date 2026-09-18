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
import { publicPetAgeOptions, type PetAgeMode } from "@/lib/schemas/fields";
import { BaseTextField } from "./BaseTextField";

export interface PetAgeFieldProps<TFieldValues extends FieldValues, TContext = unknown, TTransformedValues = TFieldValues> {
  control: Control<TFieldValues, TContext, TTransformedValues>;
  name: FieldPath<TFieldValues>;
  mode?: PetAgeMode;
  label?: ReactNode;
  placeholder?: string;
  description?: ReactNode;
  required?: boolean;
  disabled?: boolean;
  className?: string;
  triggerClassName?: string;
  contentClassName?: string;
  inputClassName?: string;
}

export function PetAgeField<TFieldValues extends FieldValues, TContext = unknown, TTransformedValues = TFieldValues>({
  control,
  name,
  mode = "publicEnum",
  label,
  placeholder,
  description,
  required,
  disabled,
  className,
  triggerClassName,
  contentClassName,
  inputClassName,
}: PetAgeFieldProps<TFieldValues, TContext, TTransformedValues>) {
  const { t } = useTranslation("forms");

  if (mode === "adminLegacyText") {
    return (
      <BaseTextField
        autoComplete="off"
        className={className}
        control={control}
        description={description}
        disabled={disabled}
        inputClassName={inputClassName}
        label={label ?? t("forms:fields.petAge.label")}
        name={name}
        placeholder={placeholder ?? t("forms:fields.petAge.legacyPlaceholder")}
        required={required}
      />
    );
  }

  return (
    <FormField
      control={control}
      name={name}
      render={({ field }) => (
        <FormItem className={className}>
          <FormLabel required={required}>{label ?? t("forms:fields.petAge.label")}</FormLabel>
          <Select
            disabled={disabled}
            onValueChange={field.onChange}
            value={typeof field.value === "string" ? field.value : ""}
          >
            <FormControl>
              <SelectTrigger aria-required={required || undefined} className={triggerClassName}>
                <SelectValue placeholder={placeholder ?? t("forms:fields.petAge.placeholder")} />
              </SelectTrigger>
            </FormControl>
            <SelectContent className={contentClassName}>
              {publicPetAgeOptions.map((option) => (
                <SelectItem key={option.value} value={option.value}>
                  {t(option.labelKey)}
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
