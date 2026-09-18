// Canonical B2B-inquiry status label/colour maps + country display, shared by
// B2BInquiriesPage (list) and B2BInquiryDetailSheet (detail). Previously both
// surfaces carried a line-for-line copy of all four; one place now, so a label,
// colour, or country tweak is a single edit with no silent per-surface drift.

export const STATUS_LABELS: Record<string, string> = {
  new: "Nowy",
  contacted: "Skontaktowany",
  qualified: "Zakwalifikowany",
  disqualified: "Odrzucony",
  closed_won: "Wygrany",
  closed_lost: "Przegrany",
};

export const STATUS_COLORS: Record<string, string> = {
  new: "bg-sky-500/15 text-sky-400 border-sky-500/30",
  contacted: "bg-warm-amber/15 text-warm-amber border-warm-amber/30",
  qualified: "bg-sage-mint/15 text-sage-mint border-sage-mint/30",
  disqualified: "bg-warm-sand text-text-muted border-offwhite/20",
  closed_won: "bg-teal/15 text-teal border-teal/30",
  closed_lost: "bg-warm-coral/15 text-warm-coral border-warm-coral/30",
};

export const COUNTRY_NAMES: Record<string, string> = {
  AU: "Australia", AT: "Austria", BE: "Belgium", CA: "Canada", CH: "Switzerland",
  CZ: "Czech Republic", DE: "Germany", DK: "Denmark", ES: "Spain", FI: "Finland",
  FR: "France", IE: "Ireland", IT: "Italy", NL: "Netherlands", NO: "Norway",
  NZ: "New Zealand", PL: "Poland", PT: "Portugal", SE: "Sweden", SK: "Slovakia",
  UK: "United Kingdom", US: "United States",
};

export function formatCountry(code: string): string {
  const name = COUNTRY_NAMES[code?.toUpperCase()];
  return name ? `${name} (${code.toUpperCase()})` : code;
}

export const ALL_STATUSES = Object.keys(STATUS_LABELS);
