import { describe, expect, it, vi } from "vitest";
import type { VercelRequest, VercelResponse } from "../../_lib/types/vercel.js";
import type { CommunicationAdminEmailSendsReadPort } from "../../../src/domains/communications/ports.js";
import {
  createCommunicationsAdminEmailSendEventsHandler,
  createCommunicationsAdminEmailSendsHandler,
} from "./adminEmailSendsHandler.js";

describe("communications admin email sends handler", () => {
  it("lists admin email sends through the shared BFF envelope", async () => {
    const readPort = createPort();
    const res = createResponse();

    await createListHandler(readPort)(
      request("GET", {
        status: "delivered",
        template: "approved",
        search: "jan",
        page: "1",
        pageSize: "20",
      }),
      res,
    );

    expect(readPort.getAdminEmailSends).toHaveBeenCalledWith({
      status: "delivered",
      template: "approved",
      search: "jan",
      page: 1,
      pageSize: 20,
    });
    expect(res.status).toHaveBeenCalledWith(200);
    expect(res.json).toHaveBeenCalledWith({
      ok: true,
      data: expect.objectContaining({ totalCount: 1 }),
    });
  });

  it("lists one send event history through the shared BFF envelope", async () => {
    const readPort = createPort();
    const res = createResponse();

    await createEventsHandler(readPort)(request("GET", { sendId: "send-1" }), res);

    expect(readPort.getAdminEmailSendEvents).toHaveBeenCalledWith({ sendId: "send-1" });
    expect(res.status).toHaveBeenCalledWith(200);
    expect(res.json).toHaveBeenCalledWith({
      ok: true,
      data: { events: [emailEvent()] },
    });
  });

  it("rejects unsupported methods, missing admin session, and invalid requests", async () => {
    const method = createResponse();
    await createListHandler(createPort())(request("POST", {}), method);

    const unauthorized = createResponse();
    await createListHandler(createPort(), false)(
      request("GET", { status: "all", template: "all", search: "", page: "0", pageSize: "20" }),
      unauthorized,
    );

    const invalid = createResponse();
    await createEventsHandler(createPort())(request("GET", {}), invalid);

    expect(method.status).toHaveBeenCalledWith(405);
    expect(unauthorized.status).toHaveBeenCalledWith(401);
    expect(invalid.status).toHaveBeenCalledWith(400);
  });

  it("maps invalid port output and upstream failures to BFF errors", async () => {
    const invalid = createResponse();
    await createListHandler(createPort({ stats: { totalSent: -1 } }))(
      request("GET", { status: "all", template: "all", search: "", page: "0", pageSize: "20" }),
      invalid,
    );

    const failed = createResponse();
    await createEventsHandler(createPort(new Error("Supabase unavailable")))(
      request("GET", { sendId: "send-1" }),
      failed,
    );

    expect(invalid.status).toHaveBeenCalledWith(502);
    expect(failed.status).toHaveBeenCalledWith(503);
    expect(payload(failed).error?.details?.reason).toBe("admin_email_send_events_read_failed");
  });

  it("adds a stable reason to admin email sends read failures", async () => {
    const failed = createResponse();
    await createListHandler(createPort(new Error("Supabase unavailable")))(
      request("GET", { status: "all", template: "all", search: "", page: "0", pageSize: "20" }),
      failed,
    );

    expect(failed.status).toHaveBeenCalledWith(503);
    expect(payload(failed).error?.code).toBe("UPSTREAM_UNAVAILABLE");
    expect(payload(failed).error?.details?.reason).toBe("admin_email_sends_read_failed");
  });
});

function createListHandler(port: CommunicationAdminEmailSendsReadPort, authorized = true) {
  return createCommunicationsAdminEmailSendsHandler({
    readPort: port,
    authorizeAdmin: vi.fn().mockResolvedValue(authorized),
  });
}

function createEventsHandler(port: CommunicationAdminEmailSendsReadPort, authorized = true) {
  return createCommunicationsAdminEmailSendEventsHandler({
    readPort: port,
    authorizeAdmin: vi.fn().mockResolvedValue(authorized),
  });
}

function request(
  method: string,
  query: Record<string, string | string[] | undefined>,
): VercelRequest {
  return { method, query } as unknown as VercelRequest;
}

function createPort(result?: unknown): CommunicationAdminEmailSendsReadPort {
  const failOr = async <T,>(value: T) => {
    if (result instanceof Error) throw result;
    return (result ?? value) as T;
  };

  return {
    getAdminEmailSends: vi.fn(() => failOr(emailSendsResponse())),
    getAdminEmailSendEvents: vi.fn(() => failOr({ events: [emailEvent()] })),
  };
}

function createResponse(): VercelResponse {
  const res = {
    setHeader: vi.fn(),
    status: vi.fn(),
    json: vi.fn(),
  } as unknown as VercelResponse;

  vi.mocked(res.status).mockReturnValue(res);
  vi.mocked(res.json).mockReturnValue(res);
  return res;
}

function payload(res: VercelResponse): {
  ok: boolean;
  error?: { code: string; details?: { reason?: string } };
} {
  return vi.mocked(res.json).mock.calls[0]![0] as never;
}

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
    resend_id: "resend-1",
    sent_at: "2026-05-31T12:00:00.000Z",
    source: "admin",
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
