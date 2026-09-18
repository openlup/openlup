import * as React from "react";
import type { ReactNode } from "react";
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
import { getDogBreedSuggestions, type DogBreedOption } from "@/lib/schemas/fields";
import { cn } from "@/lib/utils";

export interface DogBreedComboboxProps
  extends Omit<
    React.InputHTMLAttributes<HTMLInputElement>,
    "onChange" | "role" | "type" | "value"
  > {
  value: string;
  onValueChange: (value: string) => void;
  inputClassName?: string;
  listClassName?: string;
  suggestionLimit?: number;
}

export const DogBreedCombobox = React.forwardRef<HTMLInputElement, DogBreedComboboxProps>(
  (
    {
      className,
      disabled,
      inputClassName,
      listClassName,
      onBlur,
      onKeyDown,
      onValueChange,
      placeholder,
      suggestionLimit = 12,
      value,
      ...inputProps
    },
    forwardedRef,
  ) => {
    const inputId = React.useId();
    const listId = `${inputProps.id ?? inputId}-dog-breed-listbox`;
    const inputRef = React.useRef<HTMLInputElement | null>(null);
    const [open, setOpen] = React.useState(false);
    const [activeIndex, setActiveIndex] = React.useState(-1);
    const effectiveLimit = value.trim() ? suggestionLimit : 22;
    const suggestions = React.useMemo(
      () => getDogBreedSuggestions(value, effectiveLimit),
      [effectiveLimit, value],
    );

    React.useImperativeHandle(forwardedRef, () => inputRef.current as HTMLInputElement);

    React.useEffect(() => {
      if (activeIndex >= suggestions.length) setActiveIndex(-1);
    }, [activeIndex, suggestions.length]);

    const selectBreed = React.useCallback(
      (option: DogBreedOption) => {
        onValueChange(option.label);
        setOpen(false);
        setActiveIndex(-1);
      },
      [onValueChange],
    );

    return (
      <div className={cn("relative", className)}>
        <input
          {...inputProps}
          ref={inputRef}
          autoComplete={inputProps.autoComplete ?? "off"}
          className={cn(inputClassName)}
          disabled={disabled}
          onBlur={(event) => {
            setOpen(false);
            setActiveIndex(-1);
            onBlur?.(event);
          }}
          onChange={(event) => {
            onValueChange(event.target.value);
            setOpen(true);
            setActiveIndex(-1);
          }}
          onFocus={(event) => {
            setOpen(true);
            setActiveIndex(-1);
            inputProps.onFocus?.(event);
          }}
          onKeyDown={(event) => {
            onKeyDown?.(event);
            if (event.defaultPrevented) return;

            if (event.key === "ArrowDown") {
              event.preventDefault();
              setOpen(true);
              setActiveIndex((index) => (index + 1) % Math.max(suggestions.length, 1));
            } else if (event.key === "ArrowUp") {
              event.preventDefault();
              setOpen(true);
              setActiveIndex((index) =>
                index <= 0 ? Math.max(suggestions.length - 1, 0) : index - 1,
              );
            } else if (event.key === "Enter" && open && activeIndex >= 0) {
              const option = suggestions[activeIndex];
              if (!option) return;
              event.preventDefault();
              selectBreed(option);
            } else if (event.key === "Escape") {
              setOpen(false);
              setActiveIndex(-1);
            }
          }}
          placeholder={placeholder}
          role="combobox"
          aria-autocomplete="list"
          aria-controls={listId}
          aria-expanded={open && suggestions.length > 0}
          aria-activedescendant={
            activeIndex >= 0 ? `${listId}-option-${activeIndex}` : undefined
          }
          type="text"
          value={value}
        />
        {open && suggestions.length > 0 ? (
          <div
            id={listId}
            role="listbox"
            className={cn(
              "absolute left-0 right-0 z-dropdown mt-1 max-h-56 overflow-y-auto rounded-lg border border-offwhite/12 bg-charcoal p-1 shadow-lg",
              listClassName,
            )}
          >
            {suggestions.map((option, index) => (
              <button
                id={`${listId}-option-${index}`}
                key={option.value}
                type="button"
                role="option"
                aria-selected={activeIndex === index}
                className={cn(
                  "block w-full rounded-md px-3 py-2 text-left text-sm text-offwhite/75 transition-colors hover:bg-offwhite/8 hover:text-offwhite",
                  activeIndex === index && "bg-offwhite/10 text-offwhite",
                )}
                onMouseDown={(event) => event.preventDefault()}
                onMouseEnter={() => setActiveIndex(index)}
                onClick={() => selectBreed(option)}
              >
                {option.label}
              </button>
            ))}
          </div>
        ) : null}
      </div>
    );
  },
);
DogBreedCombobox.displayName = "DogBreedCombobox";

export interface DogBreedFieldProps<TFieldValues extends FieldValues, TContext = unknown, TTransformedValues = TFieldValues> {
  control: Control<TFieldValues, TContext, TTransformedValues>;
  name: FieldPath<TFieldValues>;
  label?: ReactNode;
  placeholder?: string;
  description?: ReactNode;
  required?: boolean;
  disabled?: boolean;
  className?: string;
  inputClassName?: string;
  listClassName?: string;
}

export function DogBreedField<TFieldValues extends FieldValues, TContext = unknown, TTransformedValues = TFieldValues>({
  className,
  description,
  disabled,
  inputClassName,
  label,
  listClassName,
  name,
  placeholder,
  required,
  control,
}: DogBreedFieldProps<TFieldValues, TContext, TTransformedValues>) {
  const { t } = useTranslation("forms");

  return (
    <FormField
      control={control}
      name={name}
      render={({ field }) => (
        <FormItem className={className}>
          <FormLabel required={required}>{label ?? t("forms:fields.dogBreed.label")}</FormLabel>
          <FormControl>
            <DogBreedCombobox
              ref={field.ref}
              aria-required={required || undefined}
              disabled={disabled}
              inputClassName={inputClassName}
              listClassName={listClassName}
              name={field.name}
              onBlur={field.onBlur}
              onValueChange={field.onChange}
              placeholder={placeholder ?? t("forms:fields.dogBreed.placeholder")}
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
