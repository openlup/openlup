import { describe, expect, it, vi } from "vitest";
import type { VercelRequest, VercelResponse } from "../../_lib/types/vercel.js";
import {
  CommunicationConflictError,
  type CommunicationNotificationRecipientsPort,
} from "../../../src/domains/communications/ports.js";
import {
  createCommunicationsNotificationRecipientsHandler,
} from "./notificationRecipientsHandler.js";

describe("communications notification recipients handler", () => {
  it("lists notification recipients through the shared BFF envelope", async () => {
    const port = createPort();
    const res = createResponse();

    await createHandler(port)(request("GET", undefined, { notification_type: "packaging_digest" }), res);

    expect(port.listNotificationRecipients).toHaveBeenCalledWith({
      notification_type: "packaging_digest",
    });
    expect(res.status).toHaveBeenCalledWith(200);
    expect(res.json).toHaveBeenCalledWith({ ok: true, data: { recipients: [recipient()] } });
  });

  it("does not reject notification recipients with Supabase UTC offset created_at", async () => {
    const offsetRecipient = recipient("2026-05-31T12:00:00+00:00");
    const port = createPort(undefined, [offsetRecipient]);
    const res = createResponse();

    await createHandler(port)(request("GET", undefined, { notification_type: "packaging_digest" }), res);

    expect(res.status).toHaveBeenCalledWith(200);
    expect(res.json).toHaveBeenCalledWith({
      ok: true,
      data: { recipients: [offsetRecipient] },
    });
    expect(res.json).not.toHaveBeenCalledWith({
      ok: false,
      error: expect.objectContaining({ code: "INVALID_RESPONSE" }),
    });
  });

  it("creates, updates, and deletes recipients through validated methods", async () => {
    const port = createPort();

    await createHandler(port)(
      request("POST", {
        email: "ops@example.com",
        name: "Ops",
        notification_type: "new_signup",
        active: true,
      }),
      createResponse(),
    );
    await createHandler(port)(
      request("PATCH", { recipientId: "rec-1", active: false }),
      createResponse(),
    );
    await createHandler(port)(
      request("DELETE", { recipientId: "rec-1" }),
      createResponse(),
    );

    expect(port.createNotificationRecipient).toHaveBeenCalled();
    expect(port.updateNotificationRecipient).toHaveBeenCalledWith({
      recipientId: "rec-1",
      active: false,
    });
    expect(port.deleteNotificationRecipient).toHaveBeenCalledWith({ recipientId: "rec-1" });
  });

  it("rejects unsupported methods, missing admin session, and invalid requests", async () => {
    const method = createResponse();
    await createHandler(createPort())(request("PUT"), method);

    const unauthorized = createResponse();
    await createHandler(createPort(), false)(
      request("GET", undefined, { notification_type: "packaging_digest" }),
      unauthorized,
    );

    const invalid = createResponse();
    await createHandler(createPort())(request("POST", { email: "bad" }), invalid);

    expect(method.status).toHaveBeenCalledWith(405);
    expect(unauthorized.status).toHaveBeenCalledWith(401);
    expect(invalid.status).toHaveBeenCalledWith(400);
  });

  it("maps duplicates and upstream failures to BFF errors", async () => {
    const duplicate = createResponse();
    await createHandler(
      createPort(new CommunicationConflictError("Ten email już istnieje dla tego typu powiadomień")),
    )(
      request("POST", {
        email: "ops@example.com",
        name: null,
        notification_type: "new_signup",
        active: true,
      }),
      duplicate,
    );

    const failed = createResponse();
    await createHandler(createPort(new Error("Supabase unavailable")))(
      request("DELETE", { recipientId: "rec-1" }),
      failed,
    );

    expect(duplicate.status).toHaveBeenCalledWith(409);
    expect(failed.status).toHaveBeenCalledWith(503);
  });
});

function createHandler(port: CommunicationNotificationRecipientsPort, authorized = true) {
  return createCommunicationsNotificationRecipientsHandler({
    recipientsPort: port,
    authorizeAdmin: vi.fn().mockResolvedValue(authorized),
  });
}

function request(
  method: string,
  body: unknown = {},
  query: VercelRequest["query"] = {},
): VercelRequest {
  return { method, body, query } as unknown as VercelRequest;
}

function createPort(
  error?: Error,
  recipients: ReturnType<typeof recipient>[] = [recipient()],
): CommunicationNotificationRecipientsPort {
  const failOr = async <T>(value: T) => {
    if (error) throw error;
    return value;
  };

  return {
    listNotificationRecipients: vi.fn(() => failOr({ recipients })),
    createNotificationRecipient: vi.fn((request) =>
      failOr({
        created: true as const,
        email: request.email,
        notification_type: request.notification_type,
      }),
    ),
    updateNotificationRecipient: vi.fn((request) =>
      failOr({ updated: true as const, recipientId: request.recipientId }),
    ),
    deleteNotificationRecipient: vi.fn((request) =>
      failOr({ deleted: true as const, recipientId: request.recipientId }),
    ),
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

function recipient(created_at = "2026-05-31T12:00:00.000Z") {
  return {
    id: "rec-1",
    email: "ops@example.com",
    name: "Ops",
    active: true,
    notification_type: "packaging_digest" as const,
    created_at,
  };
}
