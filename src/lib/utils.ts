import { clsx, type ClassValue } from "clsx";
import { extendTailwindMerge } from "tailwind-merge";

// Register the custom intermediate font sizes from src/index.css (@theme) so
// tailwind-merge treats them as font-size utilities. Without this, combining a
// base `text-sm` (e.g. from the cva button base) with `text-base-plus` would
// leave BOTH classes in the output, producing an unpredictable size.
// See DESIGN.md §3.
const twMerge = extendTailwindMerge({
  extend: {
    classGroups: {
      "font-size": [{ text: ["xxs", "xs-plus", "sm-plus", "base-plus"] }],
    },
  },
});

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

/**
 * Drops empty/whitespace-only parts so a detail line can be joined with a
 * separator without producing " · · " gaps for the fields the row does not have.
 */
export function compactParts(values: Array<string | null | undefined>): string[] {
  return values.filter((value): value is string => Boolean(value && value.trim()));
}

/** Renders a missing single value as the same em-less dash the detail grids use. */
export function valueOrDash(value: string | null | undefined): string {
  return value && value.trim() ? value : "-";
}
