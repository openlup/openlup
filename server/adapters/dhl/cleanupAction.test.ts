import { describe, expect, it, vi } from "vitest";
import {
  CLEANUP_URL,
  createCleanupAction,
  escapeXml,
  extractXmlValue,
  type CleanupClient,
} from "./cleanupAction.js";

describe("cleanup action", () => {
  it("uses the hosted cleanup endpoint", () => {
    expect(CLEANUP_URL).toBe("https://dhl24.com.pl/webapi2/provider/service.html?ws=1");
  });

  it("escapes XML-sensitive values and extracts namespaced or plain response fields", () => {
    expect(escapeXml(`A&B<"'`)).toBe("A&amp;B&lt;&quot;&apos;");
    expect(extractXmlValue("<ns:result>true</ns:result>", "result")).toBe("true");
    expect(extractXmlValue("<result>false</result>", "result")).toBe("false");
  });

  it("returns handler-style authentication failures before constructing a client", async () => {
    const createClient = vi.fn((): CleanupClient => { throw new Error("client must stay lazy"); });
    const action = cleanupAction({ createClient });

    await expect(action(request())).resolves.toMatchObject({ status: 200 });
    await expect(action(request()).then((response) => response.json())).resolves.toEqual({ error: "Unauthorized" });
    expect(createClient).not.toHaveBeenCalled();

    const invalid = cleanupFixture({ authError: { message: "expired" } });
    await expect(invalid.action(request({ authorization: "Bearer invalid" })).then((response) => response.json()))
      .resolves.toEqual({ error: "Invalid token" });
    expect(invalid.fetchImpl).not.toHaveBeenCalled();

    const missingUser = cleanupFixture({ authenticatedUser: null });
    await expect(missingUser.action(request({ authorization: "Bearer invalid" })).then((response) => response.json()))
      .resolves.toEqual({ error: "Invalid token" });
    expect(missingUser.fetchImpl).not.toHaveBeenCalled();
  });

  it("keeps its Web OPTIONS branch side-effect free", async () => {
    const createClient = vi.fn((): CleanupClient => { throw new Error("client must stay lazy"); });
    const action = cleanupAction({ createClient });
    await expect(action(new Request("https://example.test", { method: "OPTIONS" })).then((response) => response.text()))
      .resolves.toBe("ok");
    expect(createClient).not.toHaveBeenCalled();
  });

  it("returns the existing not-admin body before provider or storage effects", async () => {
    const fixture = cleanupFixture({ admin: null });

    await expect(fixture.action(request({ authorization: "Bearer token" })).then((response) => response.json()))
      .resolves.toEqual({ error: "Not an admin" });
    expect(fixture.fetchImpl).not.toHaveBeenCalled();
    expect(fixture.remove).not.toHaveBeenCalled();
  });

  it("deletes the provider shipment before its label and preserves the success body", async () => {
    const fixture = cleanupFixture({
      responseText: "<result>true</result>",
      username: "user<&>",
      password: "pass<&>",
    });

    await expect(fixture.action(request({
      authorization: "Bearer token",
      body: { tracking_number: `TRK<&>` },
    })).then((response) => response.json())).resolves.toEqual(cleanupBody({ providerDeleted: true, labelDeleted: true }));
    expect(fixture.fetchImpl).toHaveBeenCalledWith(
      CLEANUP_URL,
      expect.objectContaining({
        method: "POST",
        headers: {
          "Content-Type": "text/xml; charset=utf-8",
          SOAPAction: `${CLEANUP_URL}#deleteShipments`,
        },
        body: expect.stringContaining("<item>TRK&lt;&amp;&gt;</item>"),
      }),
    );
    expect(fixture.fetchImpl.mock.calls[0]?.[1]?.body).toContain("<username>user&lt;&amp;&gt;</username>");
    expect(fixture.fetchImpl.mock.calls[0]?.[1]?.body).toContain("<password>pass&lt;&amp;&gt;</password>");
    expect(fixture.remove).toHaveBeenCalledWith(["TRK<&>.pdf"]);
    expect(fixture.fetchImpl.mock.invocationCallOrder[0]).toBeLessThan(fixture.remove.mock.invocationCallOrder[0]!);
  });

  it("preserves SOAP faults and storage failures as proceedable best effort", async () => {
    const fixture = cleanupFixture({
      responseText: "<faultstring>Shipment missing</faultstring>",
      removeError: { message: "storage unavailable" },
    });

    await expect(fixture.action(request({
      authorization: "Bearer token",
      body: { tracking_number: "TRK-1" },
    })).then((response) => response.json())).resolves.toEqual(cleanupBody({ providerError: "Shipment missing" }));
    expect(fixture.remove).toHaveBeenCalledWith(["TRK-1.pdf"]);
    expect(fixture.fetchImpl.mock.invocationCallOrder[0]).toBeLessThan(fixture.remove.mock.invocationCallOrder[0]!);
  });

  it("treats a non-true SOAP result as a proceedable provider error", async () => {
    const fixture = cleanupFixture({ responseText: "<result>false</result>" });

    await expect(fixture.action(request({
      authorization: "Bearer token",
      body: { tracking_number: "TRK-1" },
    })).then((response) => response.json())).resolves.toEqual(
      cleanupBody({ providerError: "DHL nie potwierdził usunięcia", labelDeleted: true }),
    );
  });

  it("keeps provider exceptions proceedable and still attempts storage cleanup", async () => {
    const fixture = cleanupFixture({ fetchError: new Error("provider unavailable") });

    await expect(fixture.action(request({
      authorization: "Bearer token",
      body: { tracking_number: "TRK-1" },
    })).then((response) => response.json())).resolves.toEqual(
      cleanupBody({ providerError: "Error: provider unavailable", labelDeleted: true }),
    );
    expect(fixture.remove).toHaveBeenCalledWith(["TRK-1.pdf"]);
  });

  it("keeps storage exceptions proceedable after the provider attempt", async () => {
    const fixture = cleanupFixture({ removeThrow: new Error("storage unavailable") });

    await expect(fixture.action(request({
      authorization: "Bearer token",
      body: { tracking_number: "TRK-1" },
    })).then((response) => response.json())).resolves.toEqual(cleanupBody({ providerDeleted: true }));
    expect(fixture.events).toEqual(["provider", "storage"]);
  });

  it("does not call provider or storage for a falsey tracking number", async () => {
    const fixture = cleanupFixture();
    await expect(fixture.action(request({
      authorization: "Bearer token",
      body: { tracking_number: "" },
    })).then((response) => response.json())).resolves.toEqual(cleanupBody());
    expect(fixture.fetchImpl).not.toHaveBeenCalled();
    expect(fixture.remove).not.toHaveBeenCalled();
  });

  it("maps malformed JSON and unexpected client failures through the legacy proceedable body", async () => {
    const malformed = cleanupFixture();
    await expect(malformed.action(new Request("https://example.test", {
      method: "POST",
      headers: { Authorization: "Bearer token" },
      body: "{",
    })).then((response) => response.json())).resolves.toMatchObject(
      cleanupBody({ providerError: expect.stringContaining("SyntaxError") }),
    );
    expect(malformed.fetchImpl).not.toHaveBeenCalled();

    const createClient = vi.fn(() => { throw new Error("client unavailable"); });
    const action = cleanupAction({ createClient });
    await expect(action(request({ authorization: "Bearer token" })).then((response) => response.json()))
      .resolves.toEqual(cleanupBody({ providerError: "Error: client unavailable" }));
  });
});

function cleanupAction(options: { createClient?: () => CleanupClient } = {}) {
  return createCleanupAction({
    createClient: options.createClient ?? cleanupFixture().clientFactory,
    fetchImpl: vi.fn() as never,
    username: "user",
    password: "pass",
  });
}

function cleanupFixture(options: {
  authError?: unknown;
  authenticatedUser?: { id: string } | null;
  admin?: { id: string } | null;
  responseText?: string;
  fetchError?: Error;
  removeError?: { message: string } | null;
  removeThrow?: Error;
  username?: string;
  password?: string;
} = {}) {
  const events: string[] = [];
  const fetchImpl = options.fetchError
    ? vi.fn(async (_input: Parameters<typeof fetch>[0], _init?: RequestInit): Promise<Response> => {
      events.push("provider");
      throw options.fetchError;
    })
    : vi.fn(async (_input: Parameters<typeof fetch>[0], _init?: RequestInit): Promise<Response> => {
      events.push("provider");
      return new Response(options.responseText ?? "<result>true</result>");
    });
  const remove = vi.fn(async () => {
    events.push("storage");
    if (options.removeThrow) throw options.removeThrow;
    return { error: options.removeError ?? null };
  });
  const client = {
    auth: {
      getUser: vi.fn(async () => ({
        data: { user: options.authenticatedUser === undefined ? { id: "admin-1" } : options.authenticatedUser },
        error: options.authError ?? null,
      })),
    },
    from: vi.fn(() => ({
      select: vi.fn(() => ({
        eq: vi.fn(() => ({
          maybeSingle: vi.fn(async () => ({ data: options.admin === undefined ? { id: "admin-1" } : options.admin })),
        })),
      })),
    })),
    storage: { from: vi.fn(() => ({ remove })) },
  } as unknown as CleanupClient;
  const clientFactory = vi.fn(() => client);
  return {
    action: createCleanupAction({
      createClient: clientFactory,
      fetchImpl: fetchImpl as never,
      username: options.username ?? "user",
      password: options.password ?? "pass",
    }),
    clientFactory,
    fetchImpl,
    remove,
    events,
  };
}

function cleanupBody(input: {
  providerDeleted?: boolean;
  providerError?: string | null | ReturnType<typeof expect.stringContaining>;
  labelDeleted?: boolean;
} = {}) {
  return {
    dhl_deleted: input.providerDeleted ?? false,
    dhl_error: input.providerError ?? null,
    label_deleted: input.labelDeleted ?? false,
    can_proceed: true,
  };
}

function request(input: {
  authorization?: string;
  body?: Record<string, unknown>;
} = {}): Request {
  const headers = new Headers({ "Content-Type": "application/json" });
  if (input.authorization) headers.set("Authorization", input.authorization);
  return new Request("https://example.test", {
    method: "POST",
    headers,
    body: JSON.stringify(input.body ?? { tracking_number: "TRK-1" }),
  });
}
