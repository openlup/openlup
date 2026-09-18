import { act, render, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { RenderRuntimeProvider } from "@/app/renderMode";
import { LazyViewportImage } from "@/components/LazyViewportImage";

describe("LazyViewportImage", () => {
  let callback: IntersectionObserverCallback;
  const observe = vi.fn();
  const disconnect = vi.fn();

  beforeEach(() => {
    observe.mockReset();
    disconnect.mockReset();
    vi.stubGlobal("IntersectionObserver", class {
      constructor(next: IntersectionObserverCallback) {
        callback = next;
      }

      observe = observe;
      disconnect = disconnect;
      unobserve = vi.fn();
      takeRecords = vi.fn(() => []);
      root = null;
      rootMargin = "";
      thresholds = [];
    });
  });

  afterEach(() => vi.unstubAllGlobals());

  it("keeps below-fold bytes out of the initial request graph", async () => {
    const { container, getByAltText, unmount } = render(
      <LazyViewportImage src="/below-fold.webp" alt="Dog tester" width={320} height={240} />,
    );
    const image = getByAltText("Dog tester");

    expect(image).not.toHaveAttribute("src");
    expect(image).toHaveAttribute("data-src", "/below-fold.webp");
    expect(observe).toHaveBeenCalledWith(image);
    expect(container.querySelector("noscript")?.innerHTML).toContain(
      'src="/below-fold.webp"',
    );

    act(() => callback([{ isIntersecting: true } as IntersectionObserverEntry], {} as IntersectionObserver));
    await waitFor(() => expect(image).toHaveAttribute("src", "/below-fold.webp"));
    expect(image).not.toHaveAttribute("data-src");
    expect(disconnect).toHaveBeenCalledTimes(1);

    unmount();
  });

  it("keeps SSG images loadable before deferred hydration reaches the section", () => {
    const { getByAltText } = render(
      <RenderRuntimeProvider mode="ssg">
        <LazyViewportImage src="/ssg-below-fold.webp" alt="Visible recipe can" width={320} height={240} />
      </RenderRuntimeProvider>,
    );

    const image = getByAltText("Visible recipe can");
    expect(image).toHaveAttribute("src", "/ssg-below-fold.webp");
    expect(image).not.toHaveAttribute("data-src");
    expect(observe).not.toHaveBeenCalled();
  });
});
