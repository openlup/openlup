import { describe, expect, it } from "vitest";
import { createNewsletterSyncProviderRegistry } from "./newsletterProviderRegistry.js";

describe("newsletter provider registry", () => {
  it("defaults to noop newsletter provider", () => {
    expect(createNewsletterSyncProviderRegistry({})).toHaveLength(1);
    expect(createNewsletterSyncProviderRegistry({})[0]).toMatchObject({
      providerKind: "noop_newsletter",
    });
  });

  it("filters unknown provider kinds until concrete adapters exist", () => {
    const providers = createNewsletterSyncProviderRegistry({
      COMMUNICATION_NEWSLETTER_PROVIDER_KINDS: "noop_newsletter,mailchimp,bad provider",
    });

    expect(providers.map((provider) => provider.providerKind)).toEqual(["noop_newsletter"]);
  });
});
