import { describe, expect, it, vi } from "vitest";
import { createSupabaseCustomerCommunicationPreferencesPort } from "./customerCommunicationPreferences.js";

describe("supabase customer communication preferences port", () => {
  it("reads unknown newsletter state without creating communication contact records", async () => {
    const customerClient = fakeClient({
      clients: [{ id: "client-1", email: "ala@example.com", first_name: "Ala", last_name: "Kot" }],
    });
    const serviceClient = fakeClient({ communication_contacts: [null] });
    const port = createSupabaseCustomerCommunicationPreferencesPort({
      customerClient: customerClient as never,
      serviceClient: serviceClient as never,
    });

    await expect(port.getPreferences("user-1")).resolves.toMatchObject({
      contact: null,
      marketingNewsletter: { purpose: "marketing_newsletter", state: "unknown", granted: false },
    });
    expect(serviceClient.rpc).not.toHaveBeenCalled();
  });

  it("writes customer self-service newsletter consent through communications RPCs", async () => {
    const customerClient = fakeClient({
      clients: [{ id: "client-1", email: "ala@example.com", first_name: "Ala", last_name: "Kot" }],
    });
    const serviceClient = fakeClient({
      communication_contacts: [{ id: "contact-1", normalized_email: "ala@example.com" }],
      communication_permissions: [{
        state: "granted",
        source: "customer_communication_preferences",
        reason: "customer_self_service_grant",
        captured_at: "2026-06-14T10:00:00.000+02:00",
        updated_at: "2026-06-14T10:00:00.000+02:00",
      }],
    });
    serviceClient.rpc
      .mockResolvedValueOnce({ data: "contact-1", error: null })
      .mockResolvedValueOnce({ data: "link-1", error: null })
      .mockResolvedValueOnce({ data: { permissionEventId: "event-1" }, error: null });

    const port = createSupabaseCustomerCommunicationPreferencesPort({
      customerClient: customerClient as never,
      serviceClient: serviceClient as never,
    });

    await expect(port.updatePreferences("user-1", { marketingNewsletterConsent: true })).resolves.toMatchObject({
      contact: { contactId: "contact-1", email: "ala@example.com" },
      marketingNewsletter: { state: "granted", granted: true },
    });

    expect(serviceClient.rpc).toHaveBeenNthCalledWith(1, "communication_touch_contact", expect.objectContaining({
      p_email: "ala@example.com",
      p_metadata: { source: "customer_communication_preferences" },
    }));
    expect(serviceClient.rpc).toHaveBeenNthCalledWith(2, "communication_link_contact", expect.objectContaining({
      p_contact_id: "contact-1",
      p_source_table: "clients",
      p_source_id: "client-1",
    }));
    expect(serviceClient.rpc).toHaveBeenNthCalledWith(3, "communication_record_permission_event", expect.objectContaining({
      p_contact_id: "contact-1",
      p_purpose: "marketing_newsletter",
      p_state: "granted",
      p_source: "customer_communication_preferences",
      p_metadata: expect.objectContaining({
        actorType: "customer_self_service",
        captureMethod: "customer_account",
      }),
      p_create_sync_event: true,
    }));
  });
});

function fakeClient(tableRows: Record<string, unknown[]>) {
  const queues = new Map(Object.entries(tableRows).map(([key, value]) => [key, [...value]]));
  return {
    rpc: vi.fn(),
    from: vi.fn((tableName: string) => ({
      select: vi.fn(() => query(queues, tableName)),
    })),
  };
}

function query(queues: Map<string, unknown[]>, tableName: string) {
  const chain = {
    eq: vi.fn(() => chain),
    maybeSingle: vi.fn(async () => ({
      data: queues.get(tableName)?.shift() ?? null,
      error: null,
    })),
  };
  return chain;
}
