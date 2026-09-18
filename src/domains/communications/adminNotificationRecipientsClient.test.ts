import { describe, expect, it, vi } from "vitest";
import {
  createAdminNotificationRecipient,
  deleteAdminNotificationRecipient,
  getAdminNotificationRecipients,
  updateAdminNotificationRecipient,
} from "./adminNotificationRecipientsClient";

describe("admin notification recipients client", () => {
  it("passes list requests and bearer auth through the BFF client", async () => {
    const fetcher = fetcherFor({ recipients: [] });

    await getAdminNotificationRecipients(
      "access-token",
      { notification_type: "packaging_digest" },
      { fetcher },
    );

    const [path, init] = fetcher.mock.calls[0] as [string, RequestInit];
    expect(path).toBe(
      "/api/bff/admin/communications/notification-recipients?notification_type=packaging_digest",
    );
    expect(init.method).toBe("GET");
    expect(new Headers(init.headers).get("Authorization")).toBe("Bearer access-token");
  });

  it("passes create, update, and delete mutations through the BFF client", async () => {
    const fetcher = fetcherFor({ created: true, email: "ops@example.com", notification_type: "new_signup" });

    await createAdminNotificationRecipient(
      "access-token",
      {
        email: "ops@example.com",
        name: "Ops",
        notification_type: "new_signup",
        active: true,
      },
      { fetcher },
    );
    fetcher.mockResolvedValueOnce(response({ updated: true, recipientId: "rec-1" }));
    await updateAdminNotificationRecipient(
      "access-token",
      { recipientId: "rec-1", active: false },
      { fetcher },
    );
    fetcher.mockResolvedValueOnce(response({ deleted: true, recipientId: "rec-1" }));
    await deleteAdminNotificationRecipient("access-token", { recipientId: "rec-1" }, { fetcher });

    expect(fetcher.mock.calls.map(([path]) => path)).toEqual([
      "/api/bff/admin/communications/notification-recipients",
      "/api/bff/admin/communications/notification-recipients",
      "/api/bff/admin/communications/notification-recipients",
    ]);
    expect(fetcher.mock.calls.map(([, init]) => (init as RequestInit).method)).toEqual([
      "POST",
      "PATCH",
      "DELETE",
    ]);
  });
});

function fetcherFor(data: unknown) {
  return vi.fn().mockResolvedValue(response(data));
}

function response(data: unknown) {
  return {
    status: 200,
    json: () => Promise.resolve({ ok: true, data }),
  };
}
