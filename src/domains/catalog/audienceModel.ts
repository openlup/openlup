/**
 * The audience-segment contract: the shape of a programmatic landing page that
 * addresses one named group of buyers.
 *
 * A deployment supplies the segments themselves — their names, copy, questions
 * and the variants it steers each segment towards. The *shape* is the same for
 * every adopter, so it lives here and the deployment's data module narrows it
 * (see `src/data/breeds/types.ts`, which pins the variant slug to its own closed
 * set while reusing every field declared below).
 *
 * Design note: `slug` fields are an open value space here, exactly as
 * `CatalogProductSlug` is in `./types.ts`. A deployment that wants a closed set
 * declares it on its own side; the platform contract never enumerates one.
 */

/** Coarse size band a segment falls into; drives layout and copy selection. */
export type AudienceSegmentSize = "toy" | "small" | "medium" | "large";

/** The glyph a need card renders. Closed on purpose: each value has an icon. */
export type SegmentNeedIcon =
  | "bolt"
  | "drop"
  | "gut"
  | "tooth"
  | "joint"
  | "scale"
  | "wind"
  | "eye";

/** The tint a card is painted with, resolved to design tokens by the renderer. */
export type SegmentTint = "terracotta" | "sky" | "teal" | "lavender";

/** One need card: what this segment needs, why, and how it is illustrated. */
export interface AudienceSegmentNeed {
  icon: SegmentNeedIcon;
  tint: SegmentTint;
  title: string;
  body: string;
}

/** One supporting figure inside a problem section. */
export interface AudienceSegmentFact {
  value: string;
  body: string;
}

/** One question and its answer, rendered and also emitted as `FAQPage` JSON-LD. */
export interface AudienceSegmentFaqItem {
  q: string;
  a: string;
}

/** One recommended variant with the reason it suits this segment. */
export interface AudienceSegmentVariant {
  slug: string;
  tint: SegmentTint;
  why: string;
  body: string;
}

/** The problem section: the framing this segment's page opens with. */
export interface AudienceSegmentProblem {
  eyebrow: string;
  h2: string;
  paragraphs: string[];
  facts: AudienceSegmentFact[];
}

export interface AudienceSegment {
  slug: string;
  /** Subject form of the segment name, for headings that address it directly. */
  nom: string;
  /** Possessive form of the segment name, for the "… for {gen}" head phrase. */
  gen: string;
  name: string;
  size: AudienceSegmentSize;
  weightsKg: number[];
  trait: string;
  lead: string;
  tldr: string[];
  needsLead: string;
  needs: AudienceSegmentNeed[];
  problem: AudienceSegmentProblem;
  flavoursLead: string;
  flavours: AudienceSegmentVariant[];
  faq: AudienceSegmentFaqItem[];
  heroFlavour: string;
  keyword: string;
}
