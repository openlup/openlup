import { describe, expect, it } from "vitest";
import { readFile } from "node:fs/promises";
import { createSupabaseResearchSurveySubmitPort, readNotifyTo } from "./researchSurveySubmitPort.js";

const request = {
  surveyType: "producer" as const,
  responseData: { role: "Founder" },
};

describe("supabase research survey submit port", () => {
  it("does not invent a survey notification recipient when env is empty", () => {
    expect(readNotifyTo({})).toEqual([]);
    expect(readNotifyTo({ SURVEY_RESPONSE_NOTIFY_TO: " research@example.com, ops@example.com " }))
      .toEqual(["research@example.com", "ops@example.com"]);
  });

  it("fails closed when Supabase service-role env is missing", async () => {
    const port = createSupabaseResearchSurveySubmitPort({});

    await expect(port.submitSurveyResponse(request)).rejects.toThrow("supabase_service_role_not_configured");
  });

  it("fails closed when Resend live key env is missing", async () => {
    const port = createSupabaseResearchSurveySubmitPort({
      SUPABASE_URL: "https://example.supabase.co",
      SUPABASE_SERVICE_ROLE_KEY: "service-role",
    });

    await expect(port.submitSurveyResponse(request)).rejects.toThrow("RESEND_API_KEY is required");
  });

  it("fails closed when sandbox mode lacks the sandbox key", async () => {
    const port = createSupabaseResearchSurveySubmitPort({
      SUPABASE_URL: "https://example.supabase.co",
      SUPABASE_SERVICE_ROLE_KEY: "service-role",
      RESEND_PROVIDER_MODE: "sandbox",
    });

    await expect(port.submitSurveyResponse(request)).rejects.toThrow("RESEND_SANDBOX_API_KEY");
  });

  it("composes the Node capability seam without a dynamic module bridge", async () => {
    const source = await readFile(new URL("./researchSurveySubmitPort.ts", import.meta.url), "utf8");

    expect(source).toContain("createManagedSurveyResponseSubmit");
    expect(source).toContain("createEmailTransport");
    expect(source).not.toContain("importEdgeHandler");
    expect(source).not.toContain("await import(");
  });
});
