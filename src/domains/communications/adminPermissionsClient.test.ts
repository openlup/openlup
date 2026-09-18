import { describe, expect, it, vi } from "vitest";
import {
  getAdminCommunicationPermissions,
  updateAdminCommunicationPermission,
} from "./adminPermissionsClient";

describe("admin permissions client", () => {
  it("GETs communication permissions with the admin bearer token", async () => {
    const fetcher = vi.fn(async () =>
      new Response(JSON.stringify({
        ok: true,
        data: {
          email: "ala@example.com",
          contact: null,
          permissions: [],
          links: [],
          events: [],
        },
      })),
    );

    const response = await getAdminCommunicationPermissions(
      "token-123",
      "ala@example.com",
      { fetcher },
    );

    expect(response.email).toBe("ala@example.com");
    expect(fetcher).toHaveBeenCalledWith(
      "/api/bff/admin/communications/permissions?email=ala%40example.com",
      expect.objectContaining({
        method: "GET",
        headers: expect.any(Headers),
      }),
    );
    const init = (fetcher.mock.calls[0] as unknown as [string, RequestInit])[1];
    expect((init.headers as Headers).get("Authorization")).toBe("Bearer token-123");
  });

  it("PATCHes an admin override with a required reason", async () => {
    const fetcher = vi.fn(async () =>
      new Response(JSON.stringify({
        ok: true,
        data: {
          updated: true,
          contactId: "contact-1",
          event: { permissionEventId: "event-1" },
        },
      })),
    );

    await updateAdminCommunicationPermission(
      "token-123",
      {
        email: "ala@example.com",
        purpose: "marketing_newsletter",
        state: "suppressed",
        reason: "requested by customer in support thread",
      },
      { fetcher },
    );

    const init = (fetcher.mock.calls[0] as unknown as [string, RequestInit])[1];
    expect(init.method).toBe("PATCH");
    expect(JSON.parse(init.body as string)).toMatchObject({
      email: "ala@example.com",
      purpose: "marketing_newsletter",
      state: "suppressed",
      reason: "requested by customer in support thread",
    });
  });
});
