import { describe, expect, it } from "vitest";

import {
  ALL_STATUSES,
  COUNTRY_NAMES,
  STATUS_COLORS,
  STATUS_LABELS,
  formatCountry,
} from "@/pages/admin/b2b/b2bInquiryStatus";

// Freezes the canonical B2B-inquiry status label/colour maps + country display,
// shared by B2BInquiriesPage and B2BInquiryDetailSheet. Any label/colour change
// now surfaces here as one conscious edit instead of two copies drifting apart.

const EXPECTED_LABELS: Record<string, string> = {
  new: "Nowy",
  contacted: "Skontaktowany",
  qualified: "Zakwalifikowany",
  disqualified: "Odrzucony",
  closed_won: "Wygrany",
  closed_lost: "Przegrany",
};

const EXPECTED_COLORS: Record<string, string> = {
  new: "bg-sky-500/15 text-sky-400 border-sky-500/30",
  contacted: "bg-warm-amber/15 text-warm-amber border-warm-amber/30",
  qualified: "bg-sage-mint/15 text-sage-mint border-sage-mint/30",
  disqualified: "bg-warm-sand text-text-muted border-offwhite/20",
  closed_won: "bg-teal/15 text-teal border-teal/30",
  closed_lost: "bg-warm-coral/15 text-warm-coral border-warm-coral/30",
};

describe("B2B inquiry status map", () => {
  it("labels and colours every status with the frozen copy", () => {
    expect(STATUS_LABELS).toEqual(EXPECTED_LABELS);
    expect(STATUS_COLORS).toEqual(EXPECTED_COLORS);
    expect(ALL_STATUSES).toEqual(Object.keys(EXPECTED_LABELS));
  });

  it("formats a known country as 'Name (CODE)', case-insensitively", () => {
    expect(formatCountry("de")).toBe("Germany (DE)");
    expect(formatCountry("PL")).toBe("Poland (PL)");
    expect(COUNTRY_NAMES.US).toBe("United States");
  });

  it("returns the raw code for an unknown or empty country", () => {
    expect(formatCountry("ZZ")).toBe("ZZ");
    expect(formatCountry("")).toBe("");
  });
});
