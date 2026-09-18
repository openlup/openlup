import { act, renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useIsMobile } from "@/hooks/use-mobile";

type MatchMediaListener = () => void;

let changeListener: MatchMediaListener | undefined;

function installMatchMediaMock() {
  Object.defineProperty(window, "matchMedia", {
    writable: true,
    value: vi.fn().mockImplementation((query: string) => ({
      matches: window.innerWidth < 768,
      media: query,
      onchange: null,
      addListener: vi.fn(),
      removeListener: vi.fn(),
      addEventListener: vi.fn((_event: string, listener: MatchMediaListener) => {
        changeListener = listener;
      }),
      removeEventListener: vi.fn(),
      dispatchEvent: vi.fn(),
    })),
  });
}

describe("useIsMobile", () => {
  beforeEach(() => {
    changeListener = undefined;
    installMatchMediaMock();
  });

  it("returns false for desktop widths", async () => {
    window.innerWidth = 1280;

    const { result } = renderHook(() => useIsMobile());

    await waitFor(() => {
      expect(result.current).toBe(false);
    });
  });

  it("reacts to media query changes", async () => {
    window.innerWidth = 1024;
    const { result } = renderHook(() => useIsMobile());

    await waitFor(() => {
      expect(result.current).toBe(false);
    });

    act(() => {
      window.innerWidth = 640;
      changeListener?.();
    });

    await waitFor(() => {
      expect(result.current).toBe(true);
    });
  });
});
