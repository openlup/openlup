import type { LucideIcon } from "lucide-react";
import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

export function AdminPanel({
  children,
  className,
  testId,
}: {
  children: ReactNode;
  className?: string;
  // Panels that a suite selects by test id (the OMS detail sheet's sections) need the
  // id on the <section> itself, so `within(panel)` still scopes to the panel's content.
  testId?: string;
}) {
  return (
    <section data-testid={testId} className={cn("rounded-card border border-warm-sand bg-white shadow-sm", className)}>
      {children}
    </section>
  );
}

export function AdminStatusPill({
  children,
  tone = "neutral",
  className,
}: {
  children: ReactNode;
  tone?: "good" | "warn" | "bad" | "neutral" | "teal";
  className?: string;
}) {
  const tones = {
    good: "border-sage-mint/35 bg-sage-tint text-teal-dark",
    warn: "border-warm-amber/30 bg-warm-sand text-teal-dark",
    bad: "border-warm-coral/30 bg-coral-tint text-warm-coral",
    neutral: "border-warm-sand bg-offwhite text-text-muted",
    teal: "border-teal/25 bg-light-teal text-teal-dark",
  };
  return (
    <span
      className={cn(
        "inline-flex min-h-6 items-center gap-1 rounded-full border px-2.5 py-0.5 text-xxs font-bold leading-none",
        tones[tone],
        className,
      )}
    >
      {children}
    </span>
  );
}

export function AdminSegmented<T extends string>({
  value,
  options,
  onChange,
  className,
}: {
  value: T;
  options: Array<{ value: T; label: string; icon?: LucideIcon }>;
  onChange: (value: T) => void;
  className?: string;
}) {
  return (
    <div className={cn("inline-flex min-h-9 rounded-full border border-warm-sand bg-white p-1", className)}>
      {options.map(({ value: optionValue, label, icon: Icon }) => {
        const selected = optionValue === value;
        return (
          <button
            key={optionValue}
            type="button"
            aria-pressed={selected}
            onClick={() => onChange(optionValue)}
            className={cn(
              "focus-ring inline-flex min-h-7 items-center gap-1.5 rounded-full px-3 text-xs-plus font-bold transition-colors",
              selected ? "bg-light-teal text-teal-dark shadow-sm" : "text-text-muted hover:text-teal-dark",
            )}
          >
            {Icon ? <Icon size={14} aria-hidden="true" /> : null}
            {label}
          </button>
        );
      })}
    </div>
  );
}

export function AdminMetricCard({
  label,
  value,
  icon: Icon,
  active,
  tone = "neutral",
  onClick,
}: {
  label: string;
  value: number | string;
  icon?: LucideIcon;
  active?: boolean;
  tone?: "good" | "warn" | "bad" | "neutral" | "teal";
  onClick?: () => void;
}) {
  const accent = {
    good: "text-sage-mint",
    warn: "text-warm-amber",
    bad: "text-warm-coral",
    neutral: "text-text-muted",
    teal: "text-teal",
  };
  const content = (
    <>
      <div className="flex items-center justify-between gap-3">
        <p className="text-xxs font-bold uppercase text-text-muted">{label}</p>
        {Icon ? <Icon size={15} className={accent[tone]} aria-hidden="true" /> : null}
      </div>
      <p className="mt-1 font-display text-xl font-semibold text-teal-dark">{value}</p>
    </>
  );

  if (!onClick) {
    return (
      <div className="rounded-xl border border-warm-sand bg-white px-4 py-3 shadow-sm">
        {content}
      </div>
    );
  }

  return (
    <button
      type="button"
      aria-pressed={active}
      onClick={onClick}
      className={cn(
        "focus-ring min-h-[72px] rounded-xl border bg-white px-4 py-3 text-left shadow-sm transition",
        active ? "border-teal bg-light-teal/60" : "border-warm-sand hover:-translate-y-0.5 hover:shadow-md",
      )}
    >
      {content}
    </button>
  );
}

export function AdminSectionHeader({
  eyebrow,
  title,
  description,
  actions,
}: {
  eyebrow?: string;
  title: string;
  description?: string;
  actions?: ReactNode;
}) {
  return (
    <div className="mb-5 flex flex-col gap-3 md:flex-row md:items-end md:justify-between">
      <div>
        {eyebrow ? <p className="label-text mb-2 text-teal">{eyebrow}</p> : null}
        <h1 className="font-display text-2xl font-semibold tracking-normal text-teal-dark md:text-3xl">
          {title}
        </h1>
        {description ? <p className="mt-1 text-sm text-text-muted">{description}</p> : null}
      </div>
      {actions ? <div className="flex flex-wrap items-center gap-2">{actions}</div> : null}
    </div>
  );
}
