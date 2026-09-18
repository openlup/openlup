import { act, renderHook, waitFor } from "@testing-library/react";
import { renderToString } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { AuthSession, AuthStateListener } from "@/domains/auth/types";

const mockAuthPort = vi.hoisted(() => ({
  getSession: vi.fn<() => Promise<AuthSession | null>>(),
  onAuthStateChange: vi.fn<(listener: AuthStateListener) => () => void>(),
}));
const mockSurfaceAllowed = vi.hoisted(() => vi.fn(() => true));

vi.mock("@/lib/auth/customerAuthPortFactory", () => ({
  getCustomerAuthPort: vi.fn(() => mockAuthPort),
}));

vi.mock("@/lib/hiddenSurfaceAccess", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/hiddenSurfaceAccess")>()),
  isCustomerAccountSurfaceAllowed: () => mockSurfaceAllowed(),
}));

import { useCustomerSessionPresence } from "@/lib/useCustomerSessionPresence";
import { getCustomerAuthPort } from "@/lib/auth/customerAuthPortFactory";

const SESSION: AuthSession = {
  accessToken: "customer-token",
  user: { id: "customer-user-1", email: "buyer@example.com" },
};

describe("useCustomerSessionPresence", () => {
  let authStateListener: AuthStateListener | null;
  const unsubscribe = vi.fn();

  beforeEach(() => {
    vi.clearAllMocks();
    authStateListener = null;
    mockSurfaceAllowed.mockReturnValue(true);
    mockAuthPort.getSession.mockResolvedValue(null);
    mockAuthPort.onAuthStateChange.mockImplementation((listener) => {
      authStateListener = listener;
      return unsubscribe;
    });
  });

  it("returns false without touching the auth port when the account surface is gated off", () => {
    mockSurfaceAllowed.mockReturnValue(false);
    const { result } = renderHook(() => useCustomerSessionPresence());
    expect(result.current).toBe(false);
    expect(mockAuthPort.getSession).not.toHaveBeenCalled();
    expect(mockAuthPort.onAuthStateChange).not.toHaveBeenCalled();
    expect(getCustomerAuthPort).not.toHaveBeenCalled();
  });

  it("does not create the browser auth port during server rendering", () => {
    function Probe() {
      return <span>{String(useCustomerSessionPresence())}</span>;
    }

    expect(renderToString(<Probe />)).toContain("null");
    expect(getCustomerAuthPort).not.toHaveBeenCalled();
  });

  it("starts unknown, then reports a present session", async () => {
    mockAuthPort.getSession.mockResolvedValue(SESSION);
    const { result } = renderHook(() => useCustomerSessionPresence());
    expect(result.current).toBeNull();
    await waitFor(() => expect(result.current).toBe(true));
  });

  it("reports absence when the session probe fails", async () => {
    mockAuthPort.getSession.mockRejectedValue(new Error("network down"));
    const { result } = renderHook(() => useCustomerSessionPresence());
    await waitFor(() => expect(result.current).toBe(false));
  });

  it("follows auth-state changes and unsubscribes on unmount", async () => {
    const { result, unmount } = renderHook(() => useCustomerSessionPresence());
    await waitFor(() => expect(result.current).toBe(false));

    act(() => authStateListener?.(SESSION));
    expect(result.current).toBe(true);
    act(() => authStateListener?.(null));
    expect(result.current).toBe(false);

    unmount();
    expect(unsubscribe).toHaveBeenCalledTimes(1);
  });
});
