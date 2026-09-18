import { cva, type VariantProps } from "class-variance-authority";
import type { HTMLAttributes } from "react";
import { cn } from "@/lib/utils";

/**
 * Brand pill/tag atom. See DESIGN.md §9.1.
 *
 * Two tones matching the existing hand-rolled marketing pills:
 *   - body: recipe/flavor tags (font-body, semibold, tracking-wide)
 *   - mono: technical tags in science/nutrition sections (font-mono, uppercase)
 *
 * Color is intentionally passed via `className` (e.g. `bg-sage-mint/15
 * text-sage-mint border-sage-mint/30`) because pill colors are data-driven
 * (per flavor / per section) and too varied to enumerate as variants.
 */
const pillVariants = cva("inline-block rounded-full border text-xxs", {
  variants: {
    tone: {
      body: "font-body font-semibold tracking-wide px-3 py-1",
      mono: "font-mono uppercase px-3 py-1.5",
    },
  },
  defaultVariants: { tone: "body" },
});

export interface PillProps
  extends HTMLAttributes<HTMLSpanElement>,
    VariantProps<typeof pillVariants> {}

export function Pill({ tone, className, ...props }: PillProps) {
  return <span className={cn(pillVariants({ tone }), className)} {...props} />;
}
