import { act, fireEvent, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import CookieBanner from "@/components/CookieBanner";
import { ANALYTICS_CONSENT_EVENT } from "@/lib/analytics/dataLayer";
import { renderWithProviders } from "@/test/render";

const { mockReport } = vi.hoisted(() => ({ mockReport: vi.fn() }));
const mockLocalizedPath = vi.fn(() => "/polityka-cookies");

vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string, defaultValue?: string) => defaultValue ?? key,
  }),
}));

vi.mock("@/lib/i18nRoutes", () => ({
  useLocalizedPath: () => mockLocalizedPath,
}));

vi.mock("@/lib/telemetry/checkoutClientEvent", () => ({
  reportCheckoutClientEvent: mockReport,
}));

const STRIP = { name: "common:cookieBanner.regionLabel" } as const;
const heightToken = () =>
  document.documentElement.style.getPropertyValue("--consent-prompt-height");
const originalMatchMedia = window.matchMedia;

// jsdom applies no media queries and no Tailwind, so both presentations are in
// the DOM here; the viewport only decides which stage the counter reports.
function emulateViewport(desktop: boolean) {
  Object.defineProperty(window, "matchMedia", {
    configurable: true,
    writable: true,
    value: vi.fn((query: string) => ({
      matches: desktop && query === "(min-width: 48rem)",
      media: query,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    })),
  });
}

async function expectPromptClosed() {
  await waitFor(() => {
    expect(screen.queryByRole("region", STRIP)).not.toBeInTheDocument();
  });
}

describe("CookieBanner", () => {
  beforeEach(() => {
    localStorage.clear();
    document.documentElement.style.removeProperty("--consent-prompt-height");
    mockLocalizedPath.mockClear();
    mockReport.mockClear();
    emulateViewport(false);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    Object.defineProperty(window, "matchMedia", {
      configurable: true,
      writable: true,
      value: originalMatchMedia,
    });
  });

  it("renders the strip when consent is missing and accepts all cookies", async () => {
    renderWithProviders(<CookieBanner />);

    const strip = screen.getByRole("region", STRIP);
    expect(strip).toBeInTheDocument();
    // The single row is the whole point: the strip must not be able to grow
    // back into the block that covered the configurator's fixed CTA.
    expect(strip.className).toContain("fixed inset-x-0 bottom-0");
    expect(strip.className).toContain("pb-[calc(0.5rem+env(safe-area-inset-bottom))]");
    expect(strip.getAttribute("style")).toContain("z-index: 9998");
    // Below `md` only the strip shows; the desktop banner is CSS-hidden there.
    expect(strip.querySelector('[data-consent-form="strip"]')?.className).toContain("md:hidden");

    expect(screen.getByRole("link", { name: "common:cookieBanner.label" })).toHaveAttribute(
      "href",
      "/polityka-cookies",
    );

    const acceptAll = screen.getByRole("button", { name: "common:cookieBanner.accept" });
    // 36 px control + 16 px padding is the ≤ 56 px budget; the class contract is
    // what a jsdom test can hold, so it is pinned here rather than a rect.
    expect(acceptAll.className).toContain("h-9");
    // The row only stays one row at 360 px because the labels cannot break and
    // the horizontal padding is the narrower px-2.5.
    expect(acceptAll.className).toContain("whitespace-nowrap");
    expect(acceptAll.className).toContain("px-2.5");
    expect(acceptAll).toHaveAttribute("type", "button");
    expect(acceptAll.className).toContain("focus-visible:ring-teal");

    fireEvent.click(acceptAll);

    await expectPromptClosed();
    expect(localStorage.getItem("cookie-consent")).toBe(
      JSON.stringify({
        necessary: true,
        functional: true,
        analytics: true,
        marketing: true,
      }),
    );
  });

  it("rejects non-essential cookies from the strip", async () => {
    renderWithProviders(<CookieBanner />);

    fireEvent.click(screen.getByRole("button", { name: "common:cookieBanner.essentialOnly" }));

    await expectPromptClosed();
    expect(localStorage.getItem("cookie-consent")).toBe(
      JSON.stringify({
        necessary: true,
        functional: false,
        analytics: false,
        marketing: false,
      }),
    );
  });

  it("restores the pre-#3415 banner as the desktop form of the same prompt", async () => {
    renderWithProviders(<CookieBanner />);

    const region = screen.getByRole("region", STRIP);
    const banner = region.querySelector('[data-consent-form="banner"]');
    // From `md` up, exactly where the configurator's fixed bars become static.
    expect(banner?.className).toContain("hidden");
    expect(banner?.className).toContain("md:flex");
    expect(banner?.textContent).toContain("common:cookieBanner.message");
    expect(screen.getByRole("link", { name: "common:cookieBanner.learnMore" })).toHaveAttribute(
      "href",
      "/polityka-cookies",
    );
    expect(screen.getByRole("button", { name: "common:cookieBanner.acceptAll" }))
      .toHaveAttribute("type", "button");

    fireEvent.click(screen.getByRole("button", { name: "common:cookieBanner.managePreferences" }));
    expect(await screen.findByText("common:cookieBanner.preferencesTitle")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Zamknij" }));

    fireEvent.click(screen.getByRole("button", { name: "common:cookieBanner.rejectNonEssential" }));

    await expectPromptClosed();
    expect(localStorage.getItem("cookie-consent")).toBe(
      JSON.stringify({
        necessary: true,
        functional: false,
        analytics: false,
        marketing: false,
      }),
    );
  });

  it("opens preferences, updates toggles, and saves the selected consent", async () => {
    renderWithProviders(<CookieBanner />);

    fireEvent.click(screen.getByRole("button", { name: "common:cookieBanner.settings" }));

    const switches = screen.getAllByRole("switch");
    expect(switches).toHaveLength(4);
    expect(switches[0]).toBeDisabled();
    switches.forEach((toggle) => expect(toggle).toHaveAttribute("aria-checked", "true"));

    fireEvent.click(switches[3]);

    fireEvent.click(screen.getByRole("button", { name: "common:cookieBanner.save" }));

    await waitFor(() => {
      expect(screen.queryByText("common:cookieBanner.preferencesTitle")).not.toBeInTheDocument();
    });
    expect(localStorage.getItem("cookie-consent")).toBe(
      JSON.stringify({
        necessary: true,
        functional: true,
        analytics: true,
        marketing: false,
      }),
    );
  });

  it("opens preferences from the external event even when consent already exists", async () => {
    localStorage.setItem(
      "cookie-consent",
      JSON.stringify({
        necessary: true,
        functional: false,
        analytics: false,
        marketing: false,
      }),
    );

    renderWithProviders(<CookieBanner />);

    expect(screen.queryByRole("region", STRIP)).not.toBeInTheDocument();

    act(() => {
      window.dispatchEvent(new Event("open-cookie-preferences"));
    });

    expect(await screen.findByText("common:cookieBanner.preferencesTitle")).toBeInTheDocument();
    expect(screen.getAllByRole("switch").map((toggle) => toggle.getAttribute("aria-checked")))
      .toEqual(["true", "false", "false", "false"]);

    fireEvent.click(screen.getByRole("button", { name: "Zamknij" }));

    await waitFor(() => {
      expect(screen.queryByText("common:cookieBanner.preferencesTitle")).not.toBeInTheDocument();
    });

    act(() => {
      window.dispatchEvent(new Event("open-cookie-preferences"));
    });
    fireEvent.click(await screen.findByRole("button", { name: "common:cookieBanner.save" }));

    await waitFor(() => {
      expect(screen.queryByText("common:cookieBanner.preferencesTitle")).not.toBeInTheDocument();
    });
    // Reopening preferences after an answer is not a prompt answer.
    expect(mockReport).not.toHaveBeenCalled();
  });

  it("keeps the stage it counted at show time when the viewport changes before the answer", async () => {
    renderWithProviders(<CookieBanner />);

    await waitFor(() => expect(mockReport).toHaveBeenCalledWith("consent_mobile", "prompt_shown"));
    emulateViewport(true);
    fireEvent.click(screen.getByRole("button", { name: "common:cookieBanner.acceptAll" }));

    await expectPromptClosed();
    expect(mockReport.mock.calls).toEqual([
      ["consent_mobile", "prompt_shown"],
      ["consent_mobile", "accepted_all"],
    ]);
  });

  it("counts the prompt once on its mobile form and the answer that closed it", async () => {
    renderWithProviders(<CookieBanner />);

    await waitFor(() => expect(mockReport).toHaveBeenCalledWith("consent_mobile", "prompt_shown"));
    fireEvent.click(screen.getByRole("button", { name: "common:cookieBanner.accept" }));

    await expectPromptClosed();
    expect(mockReport.mock.calls).toEqual([
      ["consent_mobile", "prompt_shown"],
      ["consent_mobile", "accepted_all"],
    ]);
  });

  it("counts the desktop form under its own stage", async () => {
    emulateViewport(true);
    renderWithProviders(<CookieBanner />);

    fireEvent.click(screen.getByRole("button", { name: "common:cookieBanner.rejectNonEssential" }));

    await expectPromptClosed();
    expect(mockReport.mock.calls).toEqual([
      ["consent_desktop", "prompt_shown"],
      ["consent_desktop", "rejected_non_essential"],
    ]);
  });

  it("counts preferences saved while the prompt was open as a prompt answer", async () => {
    renderWithProviders(<CookieBanner />);

    fireEvent.click(screen.getByRole("button", { name: "common:cookieBanner.settings" }));
    fireEvent.click(screen.getByRole("button", { name: "common:cookieBanner.save" }));

    await expectPromptClosed();
    expect(mockReport.mock.calls).toEqual([
      ["consent_mobile", "prompt_shown"],
      ["consent_mobile", "preferences_saved"],
    ]);
  });

  // A webview that denies site data is a supported browsing mode, not an error:
  // the choice cannot outlive the tab, but it must still apply to this document
  // and the strip must still get out of the way of the CTA underneath it.
  it("closes and dispatches the consent event when localStorage.setItem throws", async () => {
    const onConsent = vi.fn();
    window.addEventListener(ANALYTICS_CONSENT_EVENT, onConsent);
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new DOMException("denied", "SecurityError");
    });

    try {
      renderWithProviders(<CookieBanner />);

      fireEvent.click(screen.getByRole("button", { name: "common:cookieBanner.accept" }));

      await expectPromptClosed();
      expect(onConsent).toHaveBeenCalledTimes(1);
    } finally {
      window.removeEventListener(ANALYTICS_CONSENT_EVENT, onConsent);
    }
  });

  // jsdom runs no layout, so every rect it hands back is zero. That is the same
  // shape as a runtime with no ResizeObserver at all, and it exercises the floor
  // the token depends on: while the prompt is on screen the reserve is never 0.
  it("publishes --consent-prompt-height while visible and resets it to 0px after dismiss", async () => {
    renderWithProviders(<CookieBanner />);

    expect(heightToken()).toBe("56px");

    fireEvent.click(screen.getByRole("button", { name: "common:cookieBanner.accept" }));

    await expectPromptClosed();
    expect(heightToken()).toBe("0px");
  });
});
