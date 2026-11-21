import { act, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { toast } from "@/hooks/use-toast";
import { toast as sonnerToast } from "@/components/ui/sonner";
import AppRuntimeEffects from "@/routes/AppRuntimeEffects";

function ensureMatchMedia() {
  if (typeof window.matchMedia === "function") return;
  Object.defineProperty(window, "matchMedia", {
    writable: true,
    value: (query: string) => ({
      matches: false,
      media: query,
      onchange: null,
      addListener() {},
      removeListener() {},
      addEventListener() {},
      removeEventListener() {},
      dispatchEvent: () => false,
    }),
  });
}

describe("AppRuntimeEffects", () => {
  beforeEach(() => {
    ensureMatchMedia();
    localStorage.clear();
    document.querySelectorAll('script[src*="googletagmanager"]').forEach(node => node.remove());
  });

  afterEach(() => {
    sonnerToast.dismiss();
  });

  it("renders real Radix toasts and Sonner notifications while keeping Analytics consent-gated", async () => {
    const { unmount } = render(
      <MemoryRouter initialEntries={["/"]}>
        <AppRuntimeEffects />
      </MemoryRouter>,
    );

    let handle: ReturnType<typeof toast> | undefined;
    act(() => {
      handle = toast({
        title: "Subscription updated",
        description: "Next renewal date saved.",
      });
      sonnerToast("Background sync queued");
    });

    expect(await screen.findByText("Subscription updated")).toBeInTheDocument();
    expect(screen.getByText("Next renewal date saved.")).toBeInTheDocument();
    expect(await screen.findByText("Background sync queued")).toBeInTheDocument();
    expect(document.querySelector('script[src*="googletagmanager"]')).toBeNull();

    act(() => {
      handle?.dismiss();
    });
    unmount();
  });
});
