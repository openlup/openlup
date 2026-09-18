import { describe, expect, it, vi } from "vitest";
import type { VercelRequest, VercelResponse } from "../../_lib/types/vercel.js";
import {
  CommunicationConflictError,
  CommunicationRecipientNotFoundError,
  CommunicationTemplateNotFoundError,
  type CommunicationSendPort,
} from "../../../src/domains/communications/ports.js";
import { createCommunicationsSendEmailHandler } from "./sendEmailHandler.js";

describe("communications BFF send-email handler", () => {
  it("sends email through the communications port", async () => {
    const sendPort = createPort({
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
    });
    const res = createResponse();

    await createHandler({ sendPort })(
      request("POST", { recipientId: "tester-1", templateSlug: "approved" }),
      res,
    );

    expect(sendPort.sendEmail).toHaveBeenCalledWith({
      recipientId: "tester-1",
      templateSlug: "approved",
    });
    expect(res.status).toHaveBeenCalledWith(200);
    expect(res.json).toHaveBeenCalledWith({
      ok: true,
      data: {
        message: expect.objectContaining({
          id: "send-1",
          status: "sent",
          providerMessageId: "resend-1",
        }),
      },
    });
  });

  it("supports idempotent skipped responses from the port", async () => {
    const sendPort = createPort({
      message: {
        id: "send-1",
        channel: "email",
        recipientId: "tester-1",
        templateSlug: "approved",
        status: "skipped",
        provider: null,
        providerMessageId: null,
        skippedReason: "already_sent",
      },
    });
    const res = createResponse();

    await createHandler({ sendPort })(
      request("POST", {
        recipientId: "tester-1",
        templateSlug: "approved",
        idempotencyKey: "email:tester-1:approved",
      }),
      res,
    );

    expect(sendPort.sendEmail).toHaveBeenCalledWith({
      recipientId: "tester-1",
      templateSlug: "approved",
      idempotencyKey: "email:tester-1:approved",
    });
    expect(res.status).toHaveBeenCalledWith(200);
  });

  it("rejects malformed requests before hitting the port", async () => {
    const sendPort = createPort({});
    const res = createResponse();

    await createHandler({ sendPort })(
      request("POST", { recipientId: "", templateSlug: "approved" }),
      res,
    );

    expect(sendPort.sendEmail).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(400);
  });

  it("requires admin authorization", async () => {
    const sendPort = createPort({});
    const res = createResponse();

    await createHandler({ sendPort, authorized: false })(
      request("POST", { recipientId: "tester-1", templateSlug: "approved" }),
      res,
    );

    expect(sendPort.sendEmail).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(401);
  });

  it("maps known domain errors to BFF errors", async () => {
    const missingRecipient = createResponse();
    await createHandler({
      sendPort: createPort(new CommunicationRecipientNotFoundError("recipient missing")),
    })(
      request("POST", { recipientId: "tester-1", templateSlug: "approved" }),
      missingRecipient,
    );

    const missingTemplate = createResponse();
    await createHandler({
      sendPort: createPort(new CommunicationTemplateNotFoundError("template missing")),
    })(
      request("POST", { recipientId: "tester-1", templateSlug: "approved" }),
      missingTemplate,
    );

    const conflict = createResponse();
    await createHandler({
      sendPort: createPort(new CommunicationConflictError("duplicate request")),
    })(
      request("POST", { recipientId: "tester-1", templateSlug: "approved" }),
      conflict,
    );

    expect(missingRecipient.status).toHaveBeenCalledWith(404);
    expect(missingTemplate.status).toHaveBeenCalledWith(404);
    expect(conflict.status).toHaveBeenCalledWith(409);
  });

  it("maps invalid port responses and upstream failures", async () => {
    const invalid = createResponse();
    await createHandler({ sendPort: createPort({ message: { id: "" } }) })(
      request("POST", { recipientId: "tester-1", templateSlug: "approved" }),
      invalid,
    );

    const failed = createResponse();
    await createHandler({ sendPort: createPort(new Error("Resend down")) })(
      request("POST", { recipientId: "tester-1", templateSlug: "approved" }),
      failed,
    );

    expect(invalid.status).toHaveBeenCalledWith(502);
    expect(failed.status).toHaveBeenCalledWith(503);
  });

  it("rejects unsupported methods", async () => {
    const res = createResponse();

    await createHandler({ sendPort: createPort({}) })(
      request("GET", undefined),
      res,
    );

    expect(res.setHeader).toHaveBeenCalledWith("Allow", "POST");
    expect(res.status).toHaveBeenCalledWith(405);
  });
});

function createHandler({
  sendPort,
  authorized = true,
}: {
  sendPort: CommunicationSendPort;
  authorized?: boolean;
}) {
  return createCommunicationsSendEmailHandler({
    sendPort,
    authorizeAdmin: vi.fn().mockResolvedValue(authorized),
  });
}

function request(method: string, body: unknown): VercelRequest {
  return { method, body } as unknown as VercelRequest;
}

function createPort(result: unknown): CommunicationSendPort {
  return {
    sendEmail: vi.fn().mockImplementation(async () => {
      if (result instanceof Error) throw result;
      return result;
    }),
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
