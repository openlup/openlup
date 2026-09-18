import { describe, expect, it, vi } from "vitest";

import { logAdminDisabledEmailSend } from "./emailNotificationSkipLog.js";

describe("logAdminDisabledEmailSend", () => {
  it("writes a terminal skipped email_sends ledger row", async () => {
    const insert = vi.fn(() => Promise.resolve({ error: null }));
    const client = {
      from: vi.fn(() => ({ insert })),
    };

    await logAdminDisabledEmailSend({
      client,
      source: "commerce",
      templateSlug: "commerce-order-confirmation",
      originMetadata: { emailEnvironment: "test", emailBaseUrl: "https://example.test", emailOriginSource: "test" },
      providerContext: { orderId: "order-1" },
    });

    expect(client.from).toHaveBeenCalledWith("email_sends");
    expect(insert).toHaveBeenCalledWith({
      tester_id: null,
      template_slug: "commerce-order-confirmation",
      source: "commerce",
      resend_id: null,
      status: "skipped",
      sent_at: null,
      provider_error: null,
      provider_response: expect.objectContaining({
        skipped: "admin_disabled",
        emailEnvironment: "test",
        orderId: "order-1",
      }),
    });
  });
});
