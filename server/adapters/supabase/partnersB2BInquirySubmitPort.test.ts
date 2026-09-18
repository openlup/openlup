import { describe, expect, it, vi } from "vitest";
import { readFile } from "node:fs/promises";
import {
  createSupabasePartnersB2BInquirySubmitPort,
  readNotificationTo,
  runB2BInquirySubmitHandler,
} from "./partnersB2BInquirySubmitPort.js";

const request = {
  company: "Acme Pet Foods",
  country: "US",
  firstName: "Jane",
  lastName: "Smith",
  email: "jane@acmepets.com",
  phone: "+1 555 123 4567",
  notes: "Private label wet dog food for retail.",
};

describe("supabase partners B2B inquiry submit port", () => {
  it("does not invent an internal notification recipient when env is empty", () => {
    expect(readNotificationTo({})).toEqual([]);
    expect(readNotificationTo({ B2B_NOTIFICATION_EMAIL: " sales@example.com, ops@example.com " }))
      .toEqual(["sales@example.com", "ops@example.com"]);
  });

  it("maps B2B inquiry requests through an injected local runner", async () => {
    const runB2BInquirySubmit = vi.fn().mockResolvedValue({
      status: 200,
      body: { success: true, id: "inq-1" },
    });

    await expect(createSupabasePartnersB2BInquirySubmitPort({
      runB2BInquirySubmit,
    }).submitB2BInquiry(request, {
      headers: new Headers({ "x-forwarded-for": "127.0.0.1" }),
    })).resolves.toEqual({
      success: true,
      id: "inq-1",
      skipped: undefined,
      error: undefined,
      code: undefined,
      status: 200,
    });

    expect(runB2BInquirySubmit).toHaveBeenCalledWith(
      request,
      { headers: expect.any(Headers) },
      undefined,
    );
  });

  it("rejects incomplete local runner responses", async () => {
    await expect(createSupabasePartnersB2BInquirySubmitPort({
      runB2BInquirySubmit: vi.fn().mockResolvedValue({
        status: 200,
        body: {},
      }),
    }).submitB2BInquiry(request)).rejects.toThrow("B2B inquiry submit returned incomplete data");
  });

  it("composes the Node capability seam without a dynamic module bridge", async () => {
    const source = await readFile(new URL("./partnersB2BInquirySubmitPort.ts", import.meta.url), "utf8");

    expect(source).toContain("createManagedB2BInquirySubmit");
    expect(source).toContain("createEmailTransport");
    expect(source).not.toContain("importEdgeHandler");
    expect(source).not.toContain("await import(");
  });

  it("fails closed when Supabase service-role env is missing", async () => {
    await expect(runB2BInquirySubmitHandler(request, undefined, {})).resolves.toEqual({
      status: 500,
      body: {
        success: false,
        error: "supabase_service_role_not_configured",
        code: "supabase_service_role_not_configured",
      },
    });
  });

  it("fails closed when Resend live key env is missing", async () => {
    await expect(runB2BInquirySubmitHandler(request, undefined, {
      SUPABASE_URL: "https://example.supabase.co",
      SUPABASE_SERVICE_ROLE_KEY: "service-role",
    })).resolves.toEqual({
      status: 500,
      body: {
        success: false,
        error: "RESEND_API_KEY is required unless RESEND_PROVIDER_MODE=sandbox is set",
        code: "RESEND_API_KEY is required unless RESEND_PROVIDER_MODE=sandbox is set",
      },
    });
  });

  it("fails closed when sandbox mode lacks the sandbox key", async () => {
    await expect(runB2BInquirySubmitHandler(request, undefined, {
      SUPABASE_URL: "https://example.supabase.co",
      SUPABASE_SERVICE_ROLE_KEY: "service-role",
      RESEND_PROVIDER_MODE: "sandbox",
    })).resolves.toEqual({
      status: 500,
      body: {
        success: false,
        error: "RESEND_PROVIDER_MODE=sandbox requires RESEND_SANDBOX_API_KEY",
        code: "RESEND_PROVIDER_MODE=sandbox requires RESEND_SANDBOX_API_KEY",
      },
    });
  });

});
