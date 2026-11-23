import { describe, expect, it, vi } from "vitest";
import { readFile } from "node:fs/promises";
import { createServiceRoleClient } from "../../_lib/admin-domain/auth.js";
import type { HttpRequest, HttpResponse } from "../../_lib/types/http.js";
import { createManagedSurveyResponseSubmit } from "../../domains/marketing/research/managedSurveyResponseSubmit.js";
import { createResearchSurveySubmitHandler } from "../../domains/marketing/research/surveyResponseSubmitHandler.js";
import { createSupabaseResearchSurveySubmitPort, readNotifyTo } from "./researchSurveySubmitPort.js";

vi.mock("../../_lib/admin-domain/auth.js", () => ({ createServiceRoleClient: vi.fn() }));
vi.mock("../../domains/marketing/research/managedSurveyResponseSubmit.js", { spy: true });

const request = {
  surveyType: "producer" as const,
  responseData: { role: "Founder" },
};
const address = "192.0.2.7";

describe("supabase research survey submit port", () => {
  it("does not invent a survey notification recipient when env is empty", () => {
    expect(readNotifyTo({})).toEqual([]);
    expect(readNotifyTo({ SURVEY_RESPONSE_NOTIFY_TO: " research@example.com, ops@example.com " }))
      .toEqual(["research@example.com", "ops@example.com"]);
  });

  it("fails closed when Supabase service-role env is missing", async () => {
    const port = createSupabaseResearchSurveySubmitPort({}, address);

    await expect(port.submitSurveyResponse(request)).rejects.toThrow("supabase_service_role_not_configured");
  });

  it("fails closed when Resend live key env is missing", async () => {
    const port = createSupabaseResearchSurveySubmitPort({
      SUPABASE_URL: "https://example.supabase.co",
      SUPABASE_SERVICE_ROLE_KEY: "service-role",
    }, address);

    await expect(port.submitSurveyResponse(request)).rejects.toThrow("RESEND_API_KEY is required");
  });

  it("fails closed when sandbox mode lacks the sandbox key", async () => {
    const port = createSupabaseResearchSurveySubmitPort({
      SUPABASE_URL: "https://example.supabase.co",
      SUPABASE_SERVICE_ROLE_KEY: "service-role",
      RESEND_PROVIDER_MODE: "sandbox",
    }, address);

    await expect(port.submitSurveyResponse(request)).rejects.toThrow("RESEND_SANDBOX_API_KEY");
  });

  it("uses the bound address for both gateway calls and forwards only the user agent to submission", async () => {
    const count = vi.fn().mockResolvedValue({ count: 0 });
    const eq = vi.fn(() => ({ gte: count }));
    const insert = vi.fn(() => ({ select: () => ({ single: async () => ({ data: { id: "survey-1" } }) }) }));
    vi.mocked(createServiceRoleClient).mockReturnValue({
      from: () => ({ select: () => ({ eq }), insert }),
    } as unknown as ReturnType<typeof createServiceRoleClient>);
    const submit = vi.fn<ReturnType<typeof createManagedSurveyResponseSubmit>>();
    vi.mocked(createManagedSurveyResponseSubmit).mockImplementationOnce(({ gateway }) => submit.mockImplementationOnce(
      async ({ responseData }, headers) => {
        const table = "survey_responses_producer";
        await gateway.checkRateLimit({ table, now: new Date(), windowMinutes: 60, maxPerIp: 3, ip: "unknown" });
        await gateway.insert({ table, responseData, ip: null, userAgent: headers?.get("user-agent") ?? null });
        return { ok: true, id: "survey-1" };
      },
    ));
    const submitPort = createSupabaseResearchSurveySubmitPort({
      SUPABASE_URL: "https://example.supabase.co",
      SUPABASE_SERVICE_ROLE_KEY: "test-service-role",
      RESEND_PROVIDER_MODE: "sandbox",
      RESEND_SANDBOX_API_KEY: "test-sandbox-key",
    }, address);
    const req = {
      method: "POST",
      body: request,
      headers: { "x-forwarded-for": "198.51.100.70", "cf-connecting-ip": "203.0.113.70", "user-agent": "test-agent" },
    } as unknown as HttpRequest;
    const res = { setHeader: vi.fn(), status: vi.fn(), json: vi.fn() } as unknown as HttpResponse;
    vi.mocked(res.status).mockReturnValue(res);
    await createResearchSurveySubmitHandler({ submitPort })(req, res);

    expect(eq).toHaveBeenCalledWith("ip_address", address);
    expect(insert).toHaveBeenCalledWith({
      response_data: request.responseData,
      ip_address: address,
      user_agent: "test-agent",
    });
    expect(Array.from(submit.mock.calls[0]?.[1] ?? [])).toEqual([["user-agent", "test-agent"]]);
  });

  it("composes the Node capability seam without a dynamic module bridge", async () => {
    const source = await readFile(new URL("./researchSurveySubmitPort.ts", import.meta.url), "utf8");

    expect(source).toContain("createManagedSurveyResponseSubmit");
    expect(source).toContain("createEmailTransport");
    expect(source).not.toContain("importEdgeHandler");
    expect(source).not.toContain("await import(");
  });
});
