import { describe, expect, it, vi } from "vitest";
import type { VercelRequest, VercelResponse } from "../../_lib/types/vercel.js";
import type {
  CommunicationAdminTemplateActiveWritePort,
  CommunicationAdminTemplateContentWritePort,
  CommunicationAdminTemplatesReadPort,
} from "../../../src/domains/communications/ports.js";
import {
  createCommunicationsAdminTemplateActiveHandler,
  createCommunicationsAdminTemplateContentHandler,
  createCommunicationsAdminTemplatesReadHandler,
} from "./adminTemplatesHandler.js";

describe("communications admin templates handler", () => {
  it("returns email templates through the BFF envelope", async () => {
    const readPort = createReadPort();
    const res = createResponse();

    await createHandler({ readPort })(request("GET"), res);

    expect(readPort.getAdminEmailTemplates).toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(200);
    expect(res.json).toHaveBeenCalledWith({
      ok: true,
      data: { templates: [template()] },
    });
  });

  it("updates active state through the BFF envelope", async () => {
    const writePort = createActiveWritePort();
    const res = createResponse();

    await createActiveHandler({ writePort })(
      request("PATCH", { templateId: "tpl-1", active: false }),
      res,
    );

    expect(writePort.updateAdminEmailTemplateActive).toHaveBeenCalledWith({
      templateId: "tpl-1",
      active: false,
    });
    expect(res.status).toHaveBeenCalledWith(200);
    expect(res.json).toHaveBeenCalledWith({
      ok: true,
      data: { updated: true, templateId: "tpl-1", active: false },
    });
  });

  it("updates template content through the BFF envelope", async () => {
    const writePort = createContentWritePort();
    const res = createResponse();

    await createContentHandler({ writePort })(
      request("PATCH", {
        templateId: "tpl-1",
        name: "Updated",
        subject: "Subject",
        bodyHtml: "<p>Body</p>",
        bodyText: null,
      }),
      res,
    );

    expect(writePort.updateAdminEmailTemplateContent).toHaveBeenCalledWith({
      templateId: "tpl-1",
      name: "Updated",
      subject: "Subject",
      bodyHtml: "<p>Body</p>",
      bodyText: null,
    });
    expect(res.status).toHaveBeenCalledWith(200);
    expect(res.json).toHaveBeenCalledWith({
      ok: true,
      data: { updated: true, templateId: "tpl-1" },
    });
  });

  it("rejects terminal no-send active and content mutations before the write ports", async () => {
    const readPort = createReadPort({ result: { templates: [template({
      id: "tpl-retired",
      slug: "daily-report",
      name: "Retired daily report",
    })] } });
    const activeWritePort = createActiveWritePort();
    const activeResponse = createResponse();

    await createActiveHandler({ readPort, writePort: activeWritePort })(
      request("PATCH", { templateId: "tpl-retired", active: true }),
      activeResponse,
    );

    const contentWritePort = createContentWritePort();
    const contentResponse = createResponse();
    await createContentHandler({ readPort, writePort: contentWritePort })(
      request("PATCH", {
        templateId: "tpl-retired",
        name: "Retired daily report",
        subject: "Subject",
        bodyHtml: "<p>Body</p>",
        bodyText: null,
      }),
      contentResponse,
    );

    expect(activeWritePort.updateAdminEmailTemplateActive).not.toHaveBeenCalled();
    expect(contentWritePort.updateAdminEmailTemplateContent).not.toHaveBeenCalled();
    expect(activeResponse.status).toHaveBeenCalledWith(400);
    expect(contentResponse.status).toHaveBeenCalledWith(400);
  });

  it("rejects executable template HTML before the DB write port is called", async () => {
    const writePort = createContentWritePort();
    const res = createResponse();

    await createContentHandler({ writePort })(
      request("PATCH", {
        templateId: "tpl-1",
        name: "Updated",
        subject: "Subject",
        bodyHtml: '<table><tr><td onclick="alert(1)"><script>alert(2)</script></td></tr></table>',
        bodyText: null,
      }),
      res,
    );

    expect(writePort.updateAdminEmailTemplateContent).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(400);
    const payload = vi.mocked(res.json).mock.calls.at(-1)?.[0] as {
      error?: { details?: { findings?: string[] } };
    };
    expect(payload?.error?.details?.findings).toEqual(expect.arrayContaining(["blocked_tag", "event_handler"]));
  });

  it("rejects unsupported methods and missing admin sessions", async () => {
    const method = createResponse();
    await createHandler({ readPort: createReadPort() })(request("POST"), method);

    const unauthorized = createResponse();
    await createHandler({ readPort: createReadPort(), authorized: false })(
      request("GET"),
      unauthorized,
    );

    expect(method.setHeader).toHaveBeenCalledWith("Allow", "GET");
    expect(method.status).toHaveBeenCalledWith(405);
    expect(unauthorized.status).toHaveBeenCalledWith(401);
  });

  it("maps invalid output, upstream failures, and authorization failures", async () => {
    const invalid = createResponse();
    await createHandler({
      readPort: createReadPort({ result: { templates: [{ slug: "bad" }] } }),
    })(request("GET"), invalid);

    const failed = createResponse();
    await createHandler({
      readPort: createReadPort({ result: new Error("Supabase unavailable") }),
    })(request("GET"), failed);

    const authFailed = createResponse();
    await createHandler({
      readPort: createReadPort(),
      authError: new Error("Auth failed"),
    })(request("GET"), authFailed);

    expect(invalid.status).toHaveBeenCalledWith(502);
    expect(failed.status).toHaveBeenCalledWith(503);
    expect(authFailed.status).toHaveBeenCalledWith(503);
  });

  it("rejects invalid active update requests", async () => {
    const invalid = createResponse();
    await createActiveHandler({ writePort: createActiveWritePort() })(
      request("PATCH", { templateId: "", active: false }),
      invalid,
    );

    const method = createResponse();
    await createActiveHandler({ writePort: createActiveWritePort() })(request("POST"), method);

    expect(invalid.status).toHaveBeenCalledWith(400);
    expect(method.setHeader).toHaveBeenCalledWith("Allow", "PATCH");
    expect(method.status).toHaveBeenCalledWith(405);
  });
});

function createHandler({
  readPort,
  authorized = true,
  authError,
}: {
  readPort: CommunicationAdminTemplatesReadPort;
  authorized?: boolean;
  authError?: Error;
}) {
  return createCommunicationsAdminTemplatesReadHandler({
    readPort,
    authorizeAdmin: vi.fn().mockImplementation(async () => {
      if (authError) throw authError;
      return authorized;
    }),
  });
}

function createActiveHandler({
  readPort = createReadPort(),
  writePort,
  authorized = true,
}: {
  readPort?: CommunicationAdminTemplatesReadPort;
  writePort: CommunicationAdminTemplateActiveWritePort;
  authorized?: boolean;
}) {
  return createCommunicationsAdminTemplateActiveHandler({
    readPort,
    writePort,
    authorizeAdmin: vi.fn().mockResolvedValue(authorized),
  });
}

function createContentHandler({
  readPort = createReadPort(),
  writePort,
  authorized = true,
}: {
  readPort?: CommunicationAdminTemplatesReadPort;
  writePort: CommunicationAdminTemplateContentWritePort;
  authorized?: boolean;
}) {
  return createCommunicationsAdminTemplateContentHandler({
    readPort,
    writePort,
    authorizeAdmin: vi.fn().mockResolvedValue(authorized),
  });
}

function request(method: string, body: unknown = {}): VercelRequest {
  return { method, body, query: {} } as unknown as VercelRequest;
}

function createReadPort({ result }: { result?: unknown } = {}): CommunicationAdminTemplatesReadPort {
  return {
    getAdminEmailTemplates: vi.fn().mockImplementation(async () => {
      if (result instanceof Error) throw result;
      return result ?? { templates: [template()] };
    }),
  };
}

function createActiveWritePort(): CommunicationAdminTemplateActiveWritePort {
  return {
    updateAdminEmailTemplateActive: vi.fn().mockResolvedValue({
      updated: true,
      templateId: "tpl-1",
      active: false,
    }),
  };
}

function createContentWritePort(): CommunicationAdminTemplateContentWritePort {
  return {
    updateAdminEmailTemplateContent: vi.fn().mockResolvedValue({
      updated: true,
      templateId: "tpl-1",
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

function template(overrides: Partial<ReturnType<typeof baseTemplate>> = {}) {
  return { ...baseTemplate(), ...overrides };
}

function baseTemplate() {
  return {
    id: "tpl-1",
    active: true,
    body_html: "<p>Hello</p>",
    body_text: null,
    name: "Approved",
    sequence_order: 1,
    slug: "approved",
    subject: "Approved",
    trigger_type: "status_change",
  };
}
