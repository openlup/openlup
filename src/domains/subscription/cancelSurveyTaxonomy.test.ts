import { describe, expect, it } from "vitest";

import {
  createCancelSurveySchema,
  subscriptionCancelSurveySchema,
} from "./selfServiceContracts.js";
import { CANCEL_SURVEY_REASON_CODES } from "#cancel-survey-reasons";

// Characterization test for E10: the cancel-survey reason taxonomy moves out of the
// generic subscription contract into a vertical-supplied data set, injected via
// `createCancelSurveySchema`. These assertions pin the byte-identical wire behaviour
// of the historical hard-coded enum so the refactor cannot silently change accepted
// values, the rejection error shape, or the persisted analytics vocabulary.

// ⛔ The frozen-digest pin for THIS deployment's six codes is not here. It froze one
// owner's bytes, so it lives beside that owner, in the deployment overlay's own
// test tree, in a pin file of the same name, and it was moved byte-identical. What stays here is what holds for every owner of the seam.

describe("cancel-survey reason taxonomy (E10)", () => {
  it("is a non-empty, duplicate-free code set whatever the deployment supplies", () => {
    expect(CANCEL_SURVEY_REASON_CODES.length).toBeGreaterThan(0);
    expect(new Set(CANCEL_SURVEY_REASON_CODES).size).toBe(CANCEL_SURVEY_REASON_CODES.length);
    // Persisted verbatim into `subscription_retention_outcomes.cancel_reason_code`
    // and aggregated by the retention views, so the members must be stable
    // identifiers rather than prose a deployment might localize.
    for (const code of CANCEL_SURVEY_REASON_CODES) expect(code).toMatch(/^[a-z][a-z0-9_]*$/u);
    // The escape hatch is platform contract, not vertical taste: a customer must
    // always be able to decline to classify.
    expect(CANCEL_SURVEY_REASON_CODES).toContain("other");
  });

  describe("createCancelSurveySchema(CANCEL_SURVEY_REASON_CODES)", () => {
    const schema = createCancelSurveySchema(CANCEL_SURVEY_REASON_CODES);

    it("accepts every current reason value", () => {
      for (const reasonCode of CANCEL_SURVEY_REASON_CODES) {
        expect(schema.safeParse({ reasonCode }).success).toBe(true);
      }
    });

    it("rejects an unknown reason value with the historical enum issue", () => {
      const result = schema.safeParse({ reasonCode: "banana" });
      expect(result.success).toBe(false);
      const issues = result.success ? [] : result.error.issues;
      expect(issues.map((issue) => ({ code: issue.code, path: issue.path }))).toEqual([
        { code: "invalid_value", path: ["reasonCode"] },
      ]);
    });

    it("treats reasonCode as optional", () => {
      expect(schema.safeParse({}).success).toBe(true);
      expect(schema.safeParse({ comment: "note", acceptedSaveOfferId: "pause-1_month" }).success).toBe(true);
    });

    it("stays strict about unknown keys", () => {
      expect(schema.safeParse({ reasonCode: "other", foo: 1 }).success).toBe(false);
    });
  });

  describe("subscriptionCancelSurveySchema (deprecated shape-only alias)", () => {
    it("validates shape only and no longer owns the vertical reason set", () => {
      // The generic contract must NOT bind membership to a vertical list: any
      // bounded, non-empty string is a valid shape. Membership is injected.
      expect(subscriptionCancelSurveySchema.safeParse({ reasonCode: "some_future_vertical_reason" }).success).toBe(true);
      expect(subscriptionCancelSurveySchema.safeParse({ reasonCode: "" }).success).toBe(false);
      expect(subscriptionCancelSurveySchema.safeParse({}).success).toBe(true);
    });
  });
});
