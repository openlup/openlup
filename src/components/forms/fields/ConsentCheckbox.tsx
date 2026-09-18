import * as React from "react";
import { Checkbox } from "@/components/ui/checkbox";
import { cn } from "@/lib/utils";

type CheckboxRootProps = React.ComponentPropsWithoutRef<typeof Checkbox>;

export interface ConsentCheckboxProps
  extends Omit<CheckboxRootProps, "checked" | "defaultChecked" | "onCheckedChange"> {
  checked: boolean;
  label: React.ReactNode;
  onCheckedChange: (checked: boolean) => void;
  description?: React.ReactNode;
  error?: React.ReactNode;
  required?: boolean;
  /**
   * Visual scope.
   * - `default`: semantic tokens (light surfaces).
   * - `dark`: fixed dark/offwhite palette (genuinely dark backgrounds, e.g. hero sections).
   * - `config`: configurator role tokens (`cfg-*`), which re-theme per host scope. Both
   *   hosts render `.account-light` today, so this resolves to dark-teal text on cream;
   *   the tone stays scope-driven rather than hardcoded so a future dark surface still
   *   reads correctly (see ConsentsCard).
   */
  tone?: "default" | "dark" | "config";
  wrapperClassName?: string;
  labelClassName?: string;
  descriptionClassName?: string;
  errorClassName?: string;
}

export const ConsentCheckbox = React.forwardRef<
  React.ElementRef<typeof Checkbox>,
  ConsentCheckboxProps
>(
  (
    {
      checked,
      className,
      description,
      descriptionClassName,
      disabled,
      error,
      errorClassName,
      id,
      label,
      labelClassName,
      onCheckedChange,
      required,
      tone = "default",
      wrapperClassName,
      "aria-describedby": ariaDescribedBy,
      "aria-invalid": ariaInvalid,
      ...props
    },
    ref,
  ) => {
    const generatedId = React.useId();
    const checkboxId = id ?? `consent-${generatedId}`;
    const descriptionId = description ? `${checkboxId}-description` : undefined;
    const errorId = error ? `${checkboxId}-error` : undefined;
    const describedBy = [ariaDescribedBy, descriptionId, errorId].filter(Boolean).join(" ") || undefined;
    const hasError = Boolean(error) || ariaInvalid === true || ariaInvalid === "true";
    const dark = tone === "dark";
    const config = tone === "config";
    const accentTone = dark || config;

    return (
      <div className={cn("space-y-1.5", wrapperClassName)}>
        <div className="flex items-start gap-3">
          <Checkbox
            ref={ref}
            id={checkboxId}
            aria-describedby={describedBy}
            aria-invalid={hasError || undefined}
            aria-required={required || undefined}
            checked={checked}
            className={cn(
              "mt-0.5 h-[18px] w-[18px] rounded-[4px] border-[1.5px] transition-colors",
              config
                ? "border-cfg-ink/25 bg-transparent data-[state=checked]:border-teal data-[state=checked]:bg-teal data-[state=checked]:text-cfg-on-accent focus-visible:ring-teal focus-visible:ring-offset-cfg-surface"
                : dark
                ? "border-offwhite/25 bg-transparent data-[state=checked]:border-teal data-[state=checked]:bg-teal data-[state=checked]:text-void focus-visible:ring-teal focus-visible:ring-offset-void"
                : "border-primary/45 bg-transparent data-[state=checked]:border-primary data-[state=checked]:bg-primary data-[state=checked]:text-primary-foreground",
              hasError && !checked && (accentTone ? "border-warm-coral/70" : "border-destructive"),
              className,
            )}
            disabled={disabled}
            onCheckedChange={(value) => onCheckedChange(value === true)}
            {...props}
          />
          <div className="min-w-0 space-y-1 leading-none">
            <label
              htmlFor={checkboxId}
              className={cn(
                "block cursor-pointer font-body text-xs-plus leading-relaxed",
                config ? "text-cfg-ink/65" : dark ? "text-offwhite/65" : "text-foreground",
                disabled && "cursor-not-allowed opacity-60",
                labelClassName,
              )}
            >
              {label}
              {required && (
                <span aria-hidden="true" className={cn("ml-1", accentTone ? "text-accent-coral" : "text-destructive")}>
                  *
                </span>
              )}
            </label>
            {description && (
              <p
                id={descriptionId}
                className={cn("font-body text-xs leading-relaxed", config ? "text-cfg-ink/45" : dark ? "text-offwhite/45" : "text-muted-foreground", descriptionClassName)}
              >
                {description}
              </p>
            )}
          </div>
        </div>
        {error && (
          <p
            id={errorId}
            className={cn("font-body text-xs-plus", accentTone ? "text-accent-coral" : "text-destructive", errorClassName)}
          >
            {error}
          </p>
        )}
      </div>
    );
  },
);

ConsentCheckbox.displayName = "ConsentCheckbox";
