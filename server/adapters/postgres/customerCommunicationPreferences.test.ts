import { describe, expect, it, vi } from "vitest";
import { createPostgresCustomerCommunicationPreferencesPort } from "./customerRecovery.js";

const response = {
  contractVersion: "customer.communication_preferences.v1",
  contact: { contactId: "11111111-1111-4111-8111-111111111111", email: "a@example.invalid" },
  marketingNewsletter: {
    purpose: "marketing_newsletter",
    state: "granted",
    granted: true,
    source: "customer_communication_preferences",
    reason: "customer_self_service_grant",
    capturedAt: "2026-08-14T08:00:00.000Z",
    updatedAt: "2026-08-14T08:00:00.000Z",
  },
};

describe("Postgres customer communication preferences", () => {
  it("maps actor read and update routines without accepting a principal argument", async () => {
    const rpc = vi.fn(async () => ({ data: response, error: null }));
    const port = createPostgresCustomerCommunicationPreferencesPort({ rpc });
    await expect(port.getPreferences("ignored")).resolves.toEqual(response);
    await expect(port.updatePreferences("ignored", { marketingNewsletterConsent: true })).resolves.toEqual(response);
    expect(rpc).toHaveBeenNthCalledWith(1, "customer_communication_preferences_as_actor");
    expect(rpc).toHaveBeenNthCalledWith(2, "customer_communication_preferences_set_as_actor", {
      p_marketing_newsletter_consent: true,
    });
  });
});
