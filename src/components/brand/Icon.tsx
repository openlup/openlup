import type { LucideIcon } from "lucide-react";
import { cn } from "@/lib/utils";

/**
 * Brand icon wrapper around lucide-react. See DESIGN.md §10.
 *
 * - Standard size tokens (sm 16 / md 20 / lg 24 / xl 32) instead of ad-hoc
 *   `size={N}`.
 * - A11y by default: decorative icons get `aria-hidden`; pass `label` for
 *   meaningful icons (e.g. icon-only buttons) to expose an accessible name.
 */
export type IconSize = "sm" | "md" | "lg" | "xl";

const SIZE_PX: Record<IconSize, number> = {
  sm: 16,
  md: 20,
  lg: 24,
  xl: 32,
};

interface IconProps {
  icon: LucideIcon;
  size?: IconSize;
  className?: string;
  /** Accessible name. When omitted, the icon is treated as decorative (aria-hidden). */
  label?: string;
}

export function Icon({ icon: LucideComp, size = "md", className, label }: IconProps) {
  const px = SIZE_PX[size];
  return (
    <LucideComp
      width={px}
      height={px}
      className={cn("shrink-0", className)}
      aria-hidden={label ? undefined : true}
      aria-label={label}
      role={label ? "img" : undefined}
    />
  );
}
