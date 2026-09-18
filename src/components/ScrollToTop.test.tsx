import { act } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import ScrollToTop from "@/components/ScrollToTop";
import { render } from "@testing-library/react";
import { MemoryRouter, useNavigate } from "react-router-dom";

describe("ScrollToTop", () => {
  const renderRoute = (route: string) => render(
    <MemoryRouter initialEntries={[route]}><ScrollToTop /></MemoryRouter>,
  );

  it("scrolls to the top when there is no hash in the URL", () => {
    const scrollToSpy = vi.spyOn(window, "scrollTo").mockImplementation(() => {});

    renderRoute("/jak-to-dziala");

    expect(scrollToSpy).toHaveBeenCalledWith(0, 0);

    scrollToSpy.mockRestore();
  });

  it("does not scroll when the URL contains a hash", () => {
    const scrollToSpy = vi.spyOn(window, "scrollTo").mockImplementation(() => {});

    renderRoute("/feedback/test-hash#details");

    expect(scrollToSpy).not.toHaveBeenCalled();

    scrollToSpy.mockRestore();
  });

  it("invalidates stale readiness for rapid return, hash, and query navigation", () => {
    vi.useFakeTimers();
    vi.spyOn(window, "scrollTo").mockImplementation(() => {});
    let navigate: ReturnType<typeof useNavigate> | null = null;
    const Driver = () => { navigate = useNavigate(); return <ScrollToTop />; };
    const view = render(<MemoryRouter initialEntries={["/a"]}><Driver /></MemoryRouter>);

    act(() => vi.advanceTimersByTime(1_500));
    expect(document.documentElement.dataset).toMatchObject({ appReadiness: "ready", appRoute: "/a" });
    act(() => { navigate!("/b"); });
    expect(document.documentElement.dataset.appReadiness).toBe("navigating");
    expect(document.documentElement.dataset.appRoute).toBeUndefined();
    act(() => { navigate!("/a"); });
    expect(document.documentElement.dataset.appReadiness).toBe("navigating");
    expect(document.documentElement.dataset.appRoute).toBeUndefined();
    act(() => vi.advanceTimersByTime(1_500));
    expect(document.documentElement.dataset).toMatchObject({ appReadiness: "ready", appRoute: "/a" });
    act(() => { navigate!("/a#details"); });
    expect(document.documentElement.dataset.appReadiness).toBe("navigating");
    expect(document.documentElement.dataset.appRoute).toBeUndefined();
    act(() => vi.advanceTimersByTime(1_500));
    expect(document.documentElement.dataset).toMatchObject({ appReadiness: "ready", appRoute: "/a#details" });
    act(() => { navigate!("/a?readiness=probe#details"); });
    expect(document.documentElement.dataset.appReadiness).toBe("navigating");
    expect(document.documentElement.dataset.appRoute).toBeUndefined();
    act(() => vi.advanceTimersByTime(1_500));
    expect(document.documentElement.dataset).toMatchObject({ appReadiness: "ready", appRoute: "/a?readiness=probe#details" });

    view.unmount();
    delete document.documentElement.dataset.appReadiness;
    delete document.documentElement.dataset.appRoute;
    vi.restoreAllMocks();
    vi.useRealTimers();
  });
});
