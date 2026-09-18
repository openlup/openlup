import { describe, expect, it, vi } from "vitest";
import { createSupabasePublicCommunicationPreferencesGateway } from "./gateway.js";

describe("public communications Supabase gateway", () => {
  it("keeps public preferences behind a memoized gateway port", () => {
    const clientFactory = vi.fn(() => ({ from: vi.fn(), rpc: vi.fn() }));
    const gateway = createSupabasePublicCommunicationPreferencesGateway(env(), { clientFactory });

    expect(gateway.preferenceTokenPort()).toBe(gateway.preferenceTokenPort());
    expect(gateway.preferenceTokenPort().updatePreference).toBeTypeOf("function");
    expect(clientFactory).toHaveBeenCalledTimes(1);
  });
});

function env() {
  return { url: "https://example.supabase.co", serviceRoleKey: "service" };
}
