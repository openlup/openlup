import { render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The boot path with every web store denied.
 *
 * A webview told to block site data makes `window.localStorage` throw on the
 * PROPERTY ACCESS. The header's session-presence effect reached that global
 * transitively — `NavAuthLink` -> `useCustomerSessionPresence` ->
 * `getCustomerAuthPort()` -> the customer auth client's `storage:` option — so
 * the denial escaped a commit-phase effect on EVERY route the header renders
 * on, and `RouteErrorBoundary` replaced the whole page with its crash card.
 *
 * ⛔ Nothing in this file may mock the auth port, the auth client, or the
 * storage boundary. The defect lived in the seam between them; a test that
 * stubs any one of the three passes with the bug restored.
 */

const DENIED = () => {
  throw new DOMException("The operation is insecure.", "SecurityError");
};

const originals = new Map<string, PropertyDescriptor>();
for (const name of ["localStorage", "sessionStorage"] as const) {
  const descriptor = Object.getOwnPropertyDescriptor(window, name);
  if (descriptor) originals.set(name, descriptor);
}

beforeEach(() => {
  vi.resetModules();
  // The surface flags production builds with; the local and CI static builds
  // run with them OFF, which is exactly why no existing lane saw this.
  vi.stubEnv("VITE_PUBLIC_HIDDEN_SURFACES_ENABLED", "true");
  vi.stubEnv("VITE_COMMERCE_V2_W12_CUSTOMER_AUTH_UI", "true");
  vi.stubEnv("VITE_SUPABASE_URL", "https://storage-denied-probe.example.co");
  vi.stubEnv("VITE_SUPABASE_PUBLISHABLE_KEY", "sb_publishable_storage_denied_probe");
  for (const name of ["localStorage", "sessionStorage"] as const) {
    Object.defineProperty(window, name, { configurable: true, get: DENIED, set: DENIED });
  }
});

afterEach(() => {
  vi.unstubAllEnvs();
  for (const [name, descriptor] of originals) Object.defineProperty(window, name, descriptor);
});

describe("client boot with web storage denied", () => {
  it("renders the header auth entry point instead of throwing out of its effect", async () => {
    const { NavAuthLink } = await import("@/components/navigation/NavAuthLink");

    expect(() =>
      render(
        <NavAuthLink
          loginPath="/sign-in"
          accountPath="/account"
          variant="bar"
          onNavigate={() => {}}
        />,
      ),
    ).not.toThrow();

    expect(screen.getByRole("link")).toHaveAttribute("href", "/sign-in");
  });

  it("builds the customer auth client on a store it can actually use", async () => {
    const { getCustomerSupabase } = await import("@/integrations/supabase/customerClient");
    const { resolveStorageOrMemory } = await import("@/lib/browserStorage");

    expect(() => getCustomerSupabase()).not.toThrow();

    const fallback = resolveStorageOrMemory("localStorage");
    fallback.setItem("probe", "value");
    expect(fallback.getItem("probe")).toBe("value");
  });

  it("resolves the customer session to absent rather than crashing the tree", async () => {
    const { getCustomerAuthPort } = await import("@/lib/auth/customerAuthPortFactory");

    await expect(getCustomerAuthPort().getSession()).resolves.toBeNull();
  });

  it("keeps the locale gate and the consent banner writes non-fatal", async () => {
    const { writeStorageItem, readStorageItem } = await import("@/lib/browserStorage");

    expect(writeStorageItem("localStorage", "locale-preference", "pl")).toBe(false);
    expect(readStorageItem("localStorage", "cookie-consent")).toBeNull();
  });
});
