import type { HTMLInputTypeAttribute, InputHTMLAttributes, ReactNode } from "react";
import type { Control, FieldPath, FieldValues } from "react-hook-form";
import {
  FormControl,
  FormDescription,
  FormField,
  FormItem,
  FormLabel,
  FormMessage,
} from "@/components/ui/form";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";

export interface BaseTextFieldProps<
  TFieldValues extends FieldValues,
  TContext = unknown,
  TTransformedValues = TFieldValues,
> {
  control: Control<TFieldValues, TContext, TTransformedValues>;
  name: FieldPath<TFieldValues>;
  label: ReactNode;
  placeholder?: string;
  description?: ReactNode;
  required?: boolean;
  disabled?: boolean;
  autoComplete?: string;
  inputMode?: InputHTMLAttributes<HTMLInputElement>["inputMode"];
  type?: HTMLInputTypeAttribute;
  className?: string;
  inputClassName?: string;
}

export function BaseTextField<
  TFieldValues extends FieldValues,
  TContext = unknown,
  TTransformedValues = TFieldValues,
>({
  control,
  name,
  label,
  placeholder,
  description,
  required,
  disabled,
  autoComplete,
  inputMode,
  type = "text",
  className,
  inputClassName,
}: BaseTextFieldProps<TFieldValues, TContext, TTransformedValues>) {
  return (
    <FormField
      control={control}
      name={name}
      render={({ field }) => (
        <FormItem className={className}>
          <FormLabel required={required}>{label}</FormLabel>
          <FormControl>
            <Input
              {...field}
              aria-required={required || undefined}
              autoComplete={autoComplete}
              className={cn(inputClassName)}
              disabled={disabled}
              inputMode={inputMode}
              placeholder={placeholder}
              type={type}
              value={field.value ?? ""}
            />
          </FormControl>
          {description && <FormDescription>{description}</FormDescription>}
          <FormMessage />
        </FormItem>
      )}
    />
  );
}
