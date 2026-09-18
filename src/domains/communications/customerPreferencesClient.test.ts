import { beforeEach, describe, expect, it, vi } from "vitest";
import { requestBff } from "@/lib/bff/client";
import {
  getCustomerCommunicationPreferences,
  updateCustomerCommunicationPreferences,
} from "./customerPreferencesClient";

vi.mock("@/lib/bff/client", () => ({ requestBff: vi.fn() }));

describe("customer communication preferences client", () => {
  beforeEach(() => {
    vi.mocked(requestBff).mockReset();
  });

  it("GETs customer preferences with the bearer token", async () => {
    vi.mocked(requestBff).mockResolvedValueOnce({});

    await getCustomerCommunicationPreferences("token-1");

    expect(vi.mocked(requestBff).mock.calls[0]?.[0]).toBe(
      "/api/bff/customers/communication-preferences",
    );
    const init = vi.mocked(requestBff).mock.calls[0]?.[2];
    expect(init).toMatchObject({ method: "GET" });
    expect((init?.headers as Headers).get("Authorization")).toBe("Bearer token-1");
  });

  it("PATCHes only the newsletter consent boolean", async () => {
    vi.mocked(requestBff).mockResolvedValueOnce({});

    await updateCustomerCommunicationPreferences("token-1", {
      marketingNewsletterConsent: true,
    });

    const init = vi.mocked(requestBff).mock.calls[0]?.[2];
    expect(init).toMatchObject({
      method: "PATCH",
      body: { marketingNewsletterConsent: true },
    });
    expect((init?.headers as Headers).get("Authorization")).toBe("Bearer token-1");
  });
});
