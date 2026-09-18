import { describe, expect, it, vi } from "vitest";
import {
  CARRIER_LABEL_ENDPOINT,
  createCarrierLabelAction,
  createCarrierLabelOperation,
  type CarrierLabelClient,
} from "./carrierLabelAction.js";

describe("carrier label action", () => {
  it("keeps authorization and OPTIONS side-effect free", async () => {
    const createClient = vi.fn((): CarrierLabelClient => { throw new Error("client must stay lazy"); });
    const action = createCarrierLabelAction({ createClient });

    await expect(action(new Request("https://example.test", { method: "OPTIONS" })).then((response) => response.text()))
      .resolves.toBe("ok");
    await expect(action(new Request("https://example.test")).then((response) => response.json()))
      .resolves.toEqual({ error: "Unauthorized" });
    expect(createClient).not.toHaveBeenCalled();
  });

  it("mints a fresh signed URL for a stored object key without provider egress", async () => {
    const fixture = labelFixture({ labelUrl: "tester-1/stored.pdf" });
    await expect(fixture.action(request()).then((response) => response.json())).resolves.toEqual({
      success: true,
      label_url: "https://cdn.example/signed",
    });
    expect(fixture.getLabel).not.toHaveBeenCalled();
    expect(fixture.createSignedUrl).toHaveBeenCalledWith("tester-1/stored.pdf", 300);
  });

  it("refuses a cache miss without provider egress", async () => {
    const fixture = labelFixture({ labelUrl: null });
    await expect(fixture.action(request()).then((response) => response.json())).resolves.toEqual({
      error: "Historical DHL label is not cached",
    });
    expect(fixture.getLabel).not.toHaveBeenCalled();
    expect(fixture.upload).not.toHaveBeenCalled();
    expect(fixture.update).not.toHaveBeenCalled();
    expect(fixture.events).toEqual([]);
  });

  it("refuses legacy object URLs instead of regenerating them", async () => {
    const fixture = labelFixture({ labelUrl: "https://legacy.example/storage/v1/object/public/label.pdf" });
    await expect(fixture.action(request()).then((response) => response.json())).resolves.toEqual({
      error: "Historical DHL label is not cached",
    });
    expect(fixture.getLabel).not.toHaveBeenCalled();
    expect(fixture.createSignedUrl).not.toHaveBeenCalled();
  });

  it("recovers a legacy private-bucket URL through a fresh storage signature", async () => {
    const fixture = labelFixture({
      labelUrl: "https://project.supabase.co/storage/v1/object/sign/dhl-labels/tester-1%2Fstored.pdf?token=expired",
    });
    await expect(fixture.action(request()).then((response) => response.json())).resolves.toEqual({
      success: true,
      label_url: "https://cdn.example/signed",
    });
    expect(fixture.getLabel).not.toHaveBeenCalled();
    expect(fixture.createSignedUrl).toHaveBeenCalledWith("tester-1/stored.pdf", 300);
  });

  it("keeps the provider SOAP operation as unbound reference source", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response("<labelData>UERG</labelData>"));
    const operation = createCarrierLabelOperation({ fetchImpl, username: "u<&", password: "p<&" });
    await expect(operation({ trackingNumber: "TRK<&" })).resolves.toEqual({ labelData: "UERG", fault: null });
    expect(fetchImpl).toHaveBeenCalledWith(CARRIER_LABEL_ENDPOINT, expect.objectContaining({
      headers: {
        "Content-Type": "text/xml; charset=utf-8",
        SOAPAction: `${CARRIER_LABEL_ENDPOINT}#getLabels`,
      },
      body: expect.stringContaining("<shipmentId>TRK&lt;&amp;</shipmentId>"),
    }));
  });
});

function labelFixture(input: {
  labelUrl?: string | null;
} = {}) {
  const events: string[] = [];
  const getLabel = vi.fn();
  const upload = vi.fn(async () => {
    events.push("upload");
    return { error: null };
  });
  const createSignedUrl = vi.fn(async () => {
    events.push("sign");
    return { data: { signedUrl: "https://cdn.example/signed" }, error: null };
  });
  const update = vi.fn(() => {
    events.push("update");
    return { eq: vi.fn().mockResolvedValue({ error: null }) };
  });
  const client = {
    auth: { getUser: vi.fn().mockResolvedValue({ data: { user: { id: "admin-1" } }, error: null }) },
    from: (table: string) => table === "admin_users"
      ? { select: () => ({ eq: () => ({ maybeSingle: vi.fn().mockResolvedValue({ data: { id: "admin-1" } }) }) }) }
      : {
        select: () => ({ eq: () => ({ single: vi.fn().mockResolvedValue({ data: {
          id: "tester-1", tracking_number: "TRK-1", label_url: input.labelUrl ?? null,
        }, error: null }) }) }),
        update,
      },
    storage: { from: vi.fn(() => ({ upload, createSignedUrl })) },
  } as unknown as CarrierLabelClient;
  return {
    action: createCarrierLabelAction({
      createClient: () => client,
    }),
    getLabel, upload, createSignedUrl, update, events,
  };
}

function request(): Request {
  return new Request("https://example.test", {
    method: "POST",
    headers: { Authorization: "Bearer token", "Content-Type": "application/json" },
    body: JSON.stringify({ tester_id: "tester-1" }),
  });
}
