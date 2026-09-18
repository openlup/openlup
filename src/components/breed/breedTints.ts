/** Mapowanie tintów kart potrzeb na tokeny z src/index.css, bez surowych kolorów. */
import type { SegmentTint } from "@/domains/catalog/audienceModel";

export const TINT_CLASSES: Record<SegmentTint, { bg: string; fg: string }> = {
  terracotta: { bg: "bg-coral-tint", fg: "text-warm-coral" },
  sky: { bg: "bg-light-teal", fg: "text-teal-dark" },
  teal: { bg: "bg-light-teal", fg: "text-teal" },
  lavender: { bg: "bg-lavender-tint", fg: "text-lavender" },
};
