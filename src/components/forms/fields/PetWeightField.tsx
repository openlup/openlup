import type { ChangeEvent, ReactNode } from "react";
import type { Control, FieldPath, FieldValues } from "react-hook-form";
import { useTranslation } from "react-i18next";
import {
  FormControl,
  FormDescription,
  FormField,
  FormItem,
  FormLabel,
  FormMessage,
} from "@/components/ui/form";
import { Input } from "@/components/ui/input";
import {
  kilogramsToPounds,
  poundsToKilograms,
  type PetWeightUnit,
} from "@/lib/schemas/fields";
import { cn } from "@/lib/utils";

export interface PetWeightFieldProps<TFieldValues extends FieldValues, TContext = unknown, TTransformedValues = TFieldValues> {
  control: Control<TFieldValues, TContext, TTransformedValues>;
  name: FieldPath<TFieldValues>;
  unit?: PetWeightUnit;
  label?: ReactNode;
  placeholder?: string;
  description?: ReactNode;
  required?: boolean;
  disabled?: boolean;
  className?: string;
  inputClassName?: string;
}

export function PetWeightField<TFieldValues extends FieldValues, TContext = unknown, TTransformedValues = TFieldValues>({
  control,
  name,
  unit = "kg",
  label,
  placeholder,
  description,
  required,
  disabled,
  className,
  inputClassName,
}: PetWeightFieldProps<TFieldValues, TContext, TTransformedValues>) {
  const { t } = useTranslation("forms");
  const unitLabel = t(`forms:fields.petWeight.units.${unit}`);

  return (
    <FormField
      control={control}
      name={name}
      render={({ field }) => (
        <FormItem className={className}>
          <FormLabel required={required}>{label ?? `${t("forms:fields.petWeight.label")} (${unitLabel})`}</FormLabel>
          <FormControl>
            <Input
              {...field}
              aria-required={required || undefined}
              autoComplete="off"
              className={cn(inputClassName)}
              disabled={disabled}
              inputMode="decimal"
              onChange={(event) => field.onChange(weightInputToKilograms(event, unit))}
              placeholder={
                placeholder ?? t(unit === "lb" ? "forms:fields.petWeight.placeholderLb" : "forms:fields.petWeight.placeholder")
              }
              type="text"
              value={formatWeightInputValue(field.value, unit)}
            />
          </FormControl>
          {description && <FormDescription>{description}</FormDescription>}
          <FormMessage />
        </FormItem>
      )}
    />
  );
}

function weightInputToKilograms(event: ChangeEvent<HTMLInputElement>, unit: PetWeightUnit): number | null {
  const parsed = parseWeightInput(event.target.value);
  if (parsed === null) return null;
  return unit === "lb" ? poundsToKilograms(parsed) : parsed;
}

function formatWeightInputValue(value: unknown, unit: PetWeightUnit): string {
  const weightKg = parseWeightInput(value);
  if (weightKg === null) return "";
  const displayValue = unit === "lb" ? kilogramsToPounds(weightKg) : weightKg;
  return formatWeightNumber(displayValue);
}

function parseWeightInput(value: unknown): number | null {
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value !== "string") return null;
  const normalized = value.trim().replace(",", ".");
  if (!normalized) return null;
  const parsed = Number(normalized);
  return Number.isFinite(parsed) ? parsed : null;
}

function formatWeightNumber(value: number): string {
  return Number.isInteger(value) ? String(value) : String(value).replace(/0+$/, "").replace(/\.$/, "");
}
