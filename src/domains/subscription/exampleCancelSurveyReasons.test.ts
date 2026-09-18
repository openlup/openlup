import { describe, expect, it } from "vitest";

import { CANCEL_SURVEY_REASON_CODES } from "./exampleCancelSurveyReasons.js";

// The platform half of `#cancel-survey-reasons`, imported by RELATIVE PATH: every
// non-hosted command here resolves the seam to this deployment's overlay, so this is
// the neutral owner's only exercise.
describe("platform cancel-survey reason owner", () => {
  it("offers a real taxonomy the cancel flow can render", () => {
    // An empty or single-option set would render a cancel flow with nothing to choose,
    // which is the "published module does not actually work" failure canon 1.1 forbids.
    expect(CANCEL_SURVEY_REASON_CODES.length).toBeGreaterThanOrEqual(3);
    expect(new Set(CANCEL_SURVEY_REASON_CODES).size).toBe(CANCEL_SURVEY_REASON_CODES.length);
    expect(CANCEL_SURVEY_REASON_CODES).toContain("other");
  });

  it("keeps every code storable verbatim in the retention column", () => {
    // These strings are PERSISTED as free text - there is no DB enum to reject a bad one.
    // Anything outside lower snake_case would make the analytics views harder to group and
    // would differ in shape from what every other deployment writes into the same column.
    for (const code of CANCEL_SURVEY_REASON_CODES) {
      expect(code, `${code} must be lower snake_case`).toMatch(/^[a-z]+(?:_[a-z]+)*$/);
    }
  });

  // NOT asserted here: that the codes name no vertical. `analyzeSurfaceFamilies()` already
  // scans this exact file set and holds `public-platform-runtime` to its baseline, so a
  // hand-rolled regex would duplicate the real gate - and, being a regex, would have to
  // SPELL the forbidden words, which the same scanner then counts against this file. The
  // ratchet is the check; this file stays clean so it can stay in the ratchet's scope.
});
