import { describe, expect, it, vi } from "vitest";
import {
  getAdminEmailSendEvents,
  getAdminEmailSends,
} from "./adminEmailSendsClient";

describe("admin email sends client", () => {
  it("passes list filters and the admin bearer token through the typed BFF client", async () => {
    const fetcher = vi.fn().mockResolvedValue({
      status: 200,
      json: () =>
        Promise.resolve({
          ok: true,
          data: emailSendsResponse(),
        }),
    });

    await getAdminEmailSends(
      "access-token",
      { status: "delivered", template: "approved", search: "jan", page: 2, pageSize: 20 },
      { fetcher },
    );

    const [path, init] = fetcher.mock.calls[0] as [string, RequestInit];
    expect(path).toBe(
      "/api/bff/admin/communications/email-sends?status=delivered&template=approved&search=jan&page=2&pageSize=20",
    );
    expect(init.method).toBe("GET");
    expect(new Headers(init.headers).get("Authorization")).toBe("Bearer access-token");
  });

  it("passes event send ids and the admin bearer token through the typed BFF client", async () => {
    const fetcher = vi.fn().mockResolvedValue({
      status: 200,
      json: () =>
        Promise.resolve({
          ok: true,
          data: { events: [emailEvent()] },
        }),
    });

    await getAdminEmailSendEvents("access-token", { sendId: "send-1" }, { fetcher });

    const [path, init] = fetcher.mock.calls[0] as [string, RequestInit];
    expect(path).toBe("/api/bff/admin/communications/email-sends/events?sendId=send-1");
    expect(init.method).toBe("GET");
    expect(new Headers(init.headers).get("Authorization")).toBe("Bearer access-token");
  });
});

function emailSendsResponse() {
  return {
    stats: {
      totalSent: 1,
      delivered: 1,
      opened: 1,
      clicked: 1,
    },
    templateSlugs: ["approved"],
    sends: [emailSend()],
    totalCount: 1,
    eventsSummary: { "send-1": ["open", "click"] },
  };
}

function emailSend() {
  return {
    id: "send-1",
    provider_error: null,
    provider_response: null,
    resend_id: null,
    sent_at: "2026-05-31T12:00:00.000Z",
    source: null,
    status: "delivered",
    template_id: null,
    template_slug: "approved",
    tester_id: "tester-1",
    testers: {
      first_name: "Jan",
      last_name: "Kowalski",
      email: "jan@example.com",
    },
  };
}

function emailEvent() {
  return {
    id: "event-1",
    event_type: "open",
    link_url: null,
    metadata: null,
    send_id: "send-1",
    timestamp: "2026-05-31T12:01:00.000Z",
  };
}
