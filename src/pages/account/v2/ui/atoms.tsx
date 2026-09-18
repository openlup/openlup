import type { ButtonHTMLAttributes, HTMLAttributes, ReactNode } from "react";
import { cn } from "@/lib/utils";

/**
 * Account redesign (V2) UI-kit atoms — shared primitives so every screen is
 * consistent "by construction". Cream/light scope (`.account-light`). Brand
 * rules: Clash Display for headings, Plus Jakarta for body, coral = primary
 * CTA only, radius control 12 / card 20, shadow-card / shadow-warm.
 * See design handoff §Design Tokens + plan §3/§PR0.
 */

/** White card on the cream surface: rounded-card + soft shadow + hairline. */
export function AccountCard({
  className,
  children,
  ...rest
}: HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      className={cn(
        "rounded-card border border-teal-dark/8 bg-card text-card-foreground shadow-card",
        className,
      )}
      {...rest}
    >
      {children}
    </div>
  );
}

/** Uppercase tracked label (teal) used above section titles and tiles. */
export function Eyebrow({
  className,
  children,
  ...rest
}: HTMLAttributes<HTMLSpanElement>) {
  return (
    <span className={cn("label-text text-teal", className)} {...rest}>
      {children}
    </span>
  );
}

/** Clash Display section heading. */
export function SectionTitle({
  as: Tag = "h2",
  className,
  children,
  ...rest
}: HTMLAttributes<HTMLHeadingElement> & { as?: "h1" | "h2" | "h3" }) {
  return (
    <Tag
      className={cn("font-display font-semibold text-foreground", className)}
      {...rest}
    >
      {children}
    </Tag>
  );
}

type ButtonProps = ButtonHTMLAttributes<HTMLButtonElement> & {
  icon?: ReactNode;
};

/** Primary CTA — coral, warm glow, hover lift. The ONLY coral surface. */
export function CoralButton({
  className,
  children,
  icon,
  type = "button",
  ...rest
}: ButtonProps) {
  return (
    <button
      type={type}
      className={cn(
        "inline-flex items-center justify-center gap-2 rounded-control bg-warm-coral px-5 py-3 font-body text-sm-plus font-semibold text-white shadow-warm transition-all duration-150 ease-[cubic-bezier(0,0,0.2,1)]",
        "hover:scale-[1.03] hover:brightness-110 motion-reduce:transform-none motion-reduce:hover:scale-100",
        "focus-ring disabled:pointer-events-none disabled:opacity-50",
        className,
      )}
      {...rest}
    >
      {icon}
      {children}
    </button>
  );
}

/** Secondary / ghost control — white pill, teal hover. */
export function GhostButton({
  className,
  children,
  icon,
  type = "button",
  ...rest
}: ButtonProps) {
  return (
    <button
      type={type}
      className={cn(
        "inline-flex items-center justify-center gap-2 rounded-control border border-teal-dark/10 bg-card px-4 py-3 font-body text-sm font-medium text-foreground transition-all duration-150",
        "hover:border-teal hover:shadow-card",
        "focus-ring disabled:pointer-events-none disabled:opacity-50",
        className,
      )}
      {...rest}
    >
      {icon}
      {children}
    </button>
  );
}

export type SubscriptionStatusTone =
  | "active"
  | "paused"
  | "blocked"
  | "pending"
  | "failed"
  | "cancelled";

const STATUS_TONES: Record<SubscriptionStatusTone, string> = {
  active: "bg-soft-sage text-teal-dark",
  paused: "bg-warm-amber/15 text-copper",
  blocked: "bg-warm-coral/12 text-warm-coral",
  pending: "bg-warm-amber/15 text-copper",
  failed: "bg-warm-coral/12 text-warm-coral",
  cancelled: "bg-teal-dark/8 text-foreground/55",
};

const STATUS_DOT: Record<SubscriptionStatusTone, string> = {
  active: "bg-green",
  paused: "bg-warm-amber",
  blocked: "bg-warm-coral",
  pending: "bg-warm-amber",
  failed: "bg-warm-coral",
  cancelled: "bg-foreground/40",
};

/** Status pill with a leading dot. Tone is derived from subscription state. */
export function StatusBadge({
  tone,
  children,
  className,
}: {
  tone: SubscriptionStatusTone;
  children: ReactNode;
  className?: string;
}) {
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-xs-plus font-semibold",
        STATUS_TONES[tone],
        className,
      )}
    >
      <span className={cn("h-1.5 w-1.5 rounded-full", STATUS_DOT[tone])} />
      {children}
    </span>
  );
}
