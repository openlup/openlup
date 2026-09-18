import { act, render, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { LazyAutoplayVideo } from "@/components/LazyAutoplayVideo";

vi.mock("framer-motion", () => ({
  useReducedMotion: () => false,
}));

describe("LazyAutoplayVideo", () => {
  let callback: IntersectionObserverCallback;
  const observe = vi.fn();
  const disconnect = vi.fn();
  const play = vi.fn(() => Promise.reject(new Error("autoplay blocked")));
  const pause = vi.fn();

  beforeEach(() => {
    observe.mockReset();
    disconnect.mockReset();
    play.mockClear();
    pause.mockClear();
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
    vi.spyOn(HTMLMediaElement.prototype, "play").mockImplementation(play);
    vi.spyOn(HTMLMediaElement.prototype, "pause").mockImplementation(pause);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("attaches the source once, then plays and pauses on every viewport transition", async () => {
    const { container, unmount } = render(<LazyAutoplayVideo src="/demo.mp4" poster="/poster.webp" />);
    const video = container.querySelector("video")!;

    expect(video).not.toHaveAttribute("src");
    expect(video).not.toHaveAttribute("poster");
    expect(observe).toHaveBeenCalledWith(video);

    act(() => callback([{ isIntersecting: true } as IntersectionObserverEntry], {} as IntersectionObserver));
    await waitFor(() => expect(video).toHaveAttribute("src", "/demo.mp4"));
    expect(video).toHaveAttribute("poster", "/poster.webp");
    await waitFor(() => expect(play).toHaveBeenCalledTimes(1));
    expect(disconnect).not.toHaveBeenCalled();

    act(() => callback([{ isIntersecting: false } as IntersectionObserverEntry], {} as IntersectionObserver));
    await waitFor(() => expect(pause).toHaveBeenCalled());
    expect(video).toHaveAttribute("src", "/demo.mp4");

    act(() => callback([{ isIntersecting: true } as IntersectionObserverEntry], {} as IntersectionObserver));
    await waitFor(() => expect(play).toHaveBeenCalledTimes(2));

    unmount();
    expect(disconnect).toHaveBeenCalledTimes(1);
  });
});
