export const LAUNCH_PRODUCT_DISPLAY = {
  lamb: {
    displayLabel: { pl: "Jagnięcina + EntoPro™", en: "Lamb + EntoPro™" },
    shortLabel: { pl: "Jagnięcina", en: "Lamb" },
    accentColor: "#00BFB3",
  },
  venison: {
    displayLabel: { pl: "Dziczyzna + EntoPro™", en: "Venison + EntoPro™" },
    shortLabel: { pl: "Dziczyzna", en: "Venison" },
    accentColor: "#8B1A4A",
  },
  beef: {
    displayLabel: { pl: "Wołowina + EntoPro™", en: "Beef + EntoPro™" },
    shortLabel: { pl: "Wołowina", en: "Beef" },
    accentColor: "#e06040",
  },
  turkey: {
    displayLabel: { pl: "Indyk + EntoPro™", en: "Turkey + EntoPro™" },
    shortLabel: { pl: "Indyk", en: "Turkey" },
    accentColor: "#50b0dc",
  },
  salmon: {
    displayLabel: { pl: "Łosoś + EntoPro™", en: "Salmon + EntoPro™" },
    shortLabel: { pl: "Łosoś", en: "Salmon" },
    accentColor: "#e6a050",
  },
  pork: {
    displayLabel: { pl: "Wieprzowina + EntoPro™", en: "Pork + EntoPro™" },
    shortLabel: { pl: "Wieprzowina", en: "Pork" },
    accentColor: "#d88e9c",
  },
} as const;

export type LaunchProductSlug = keyof typeof LAUNCH_PRODUCT_DISPLAY;
export type ProductDisplayLang = "pl" | "en";

const PRODUCT_PATTERNS: ReadonlyArray<[LaunchProductSlug, RegExp]> = [
  ["lamb", /jagniec|lamb/],
  ["venison", /dzicz|jelen|venison/],
  ["beef", /wolow|beef/],
  ["turkey", /indyk|turkey/],
  ["salmon", /losos|salmon/],
  ["pork", /wieprz|pork/],
];

function normalise(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/ł/g, "l")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "");
}

export function isLaunchProductSlug(value: string | null | undefined): value is LaunchProductSlug {
  return Boolean(value && value in LAUNCH_PRODUCT_DISPLAY);
}

export function resolveLaunchProductSlug(
  value: string | null | undefined,
): LaunchProductSlug | null {
  if (!value) return null;
  const normalised = normalise(value);
  if (isLaunchProductSlug(normalised)) return normalised;
  for (const [slug, pattern] of PRODUCT_PATTERNS) {
    if (pattern.test(normalised)) return slug;
  }
  return null;
}

export function productDisplayLabel(
  slug: string | null | undefined,
  lang: ProductDisplayLang,
): string | null {
  if (!isLaunchProductSlug(slug)) return null;
  return LAUNCH_PRODUCT_DISPLAY[slug].displayLabel[lang];
}

export function productShortLabel(
  slug: string | null | undefined,
  lang: ProductDisplayLang,
): string | null {
  if (!isLaunchProductSlug(slug)) return null;
  return LAUNCH_PRODUCT_DISPLAY[slug].shortLabel[lang];
}

export function productAccentColor(slug: string | null | undefined): string | null {
  if (!isLaunchProductSlug(slug)) return null;
  return LAUNCH_PRODUCT_DISPLAY[slug].accentColor;
}
