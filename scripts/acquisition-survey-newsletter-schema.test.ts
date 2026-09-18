import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const PATH = "db/platform/migrations/20260817130000_acquisition_survey_newsletter_evidence.sql";
const sql = readFileSync(PATH, "utf8");

describe("correlated acquisition survey and newsletter evidence schema", () => {
  it("stores content-free append-only evidence behind fixed routines", () => {
    expect(sql).toContain("CREATE TABLE acquisition_private.survey_evidence");
    expect(sql).toContain("CREATE TABLE acquisition_private.newsletter_consent_events");
    expect(sql).toContain("acquisition_survey_evidence_append_only");
    expect(sql).toContain("acquisition_newsletter_consent_events_append_only");
    expect(sql).toContain("CREATE FUNCTION public.acquisition_survey_submit_v1");
    expect(sql).toContain("CREATE FUNCTION public.acquisition_newsletter_consent_v1");
  });

  it("keeps raw survey, email and provider payload out of the new tables", () => {
    const tableSection = sql.slice(sql.indexOf("CREATE TABLE acquisition_private.survey_evidence"), sql.indexOf("CREATE INDEX"));
    expect(tableSection).not.toMatch(/response_data|normalized_email|raw_payload|provider_kind|provider_event/i);
    expect(sql).toContain("response_digest bytea");
    expect(sql).toContain("recipient_fingerprint text");
  });

  it("keeps runtime function-only and browser roles closed", () => {
    expect(sql).toContain("REVOKE ALL ON acquisition_private.survey_evidence");
    expect(sql).toContain("FROM PUBLIC, anon, authenticated, platform_acquisition_runtime");
    expect((sql.match(/^GRANT EXECUTE ON FUNCTION public\.acquisition_/gm) ?? [])).toHaveLength(3);
    expect(sql).not.toMatch(/^GRANT (?:SELECT|INSERT|UPDATE|DELETE)[^;]*TO platform_acquisition_runtime;/gim);
  });
});
