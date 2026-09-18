import { describe, expect, it, vi } from "vitest";
import { sendAdminEmail } from "./adminSendEmailClient";

describe("admin send email client", () => {
  it("sends manual email requests with the admin bearer token", async () => {
    const fetcher = vi.fn().mockResolvedValue(response({ ok: true, data: sentResponse() }));

    await sendAdminEmail(
      "admin-token",
      { recipientId: "tester-1", templateSlug: "approved" },
      { fetcher },
    );

    const [path, init] = fetcher.mock.calls[0] as [string, RequestInit];
    expect(path).toBe("/api/bff/admin/communications/send-email");
    expect(init.method).toBe("POST");
    expect(new Headers(init.headers).get("Authorization")).toBe("Bearer admin-token");
    expect(init.body).toBe(JSON.stringify({
      recipientId: "tester-1",
      templateSlug: "approved",
    }));
  });

  it("throws typed BFF errors and rejects malformed envelopes", async () => {
    const upstream = vi.fn().mockResolvedValue(
      response({
        ok: false,
        error: { code: "UPSTREAM_UNAVAILABLE", message: "provider failed" },
      }, 503),
    );

    await expect(
      sendAdminEmail(
        "admin-token",
        { recipientId: "tester-1", templateSlug: "approved" },
        { fetcher: upstream },
      ),
    ).rejects.toMatchObject({
      code: "UPSTREAM_UNAVAILABLE",
      status: 503,
      message: "provider failed",
    });

    const malformed = vi.fn().mockResolvedValue(response({ ok: true, data: { message: {} } }));
    await expect(
      sendAdminEmail(
        "admin-token",
        { recipientId: "tester-1", templateSlug: "approved" },
        { fetcher: malformed },
      ),
    ).rejects.toMatchObject({ code: "INVALID_RESPONSE", status: 200 });
  });
});

function sentResponse() {
  return {
    message: {
      id: "send-1",
      channel: "email",
      recipientId: "tester-1",
      templateSlug: "approved",
      status: "sent",
      provider: "resend",
      providerMessageId: "resend-1",
      skippedReason: null,
    },
  };
}

function response(body: unknown, status = 200) {
  return {
    status,
    json: () => Promise.resolve(body),
  };
}
