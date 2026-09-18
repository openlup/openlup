/** @vitest-environment jsdom */
import { fireEvent, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { renderWithProviders } from "@/test/render";
import {
  CHECKOUT_PAYMENT_LINK_PATH,
  FinishInBrowserHatch,
  resetFinishInBrowserHatchForTests,
} from "./FinishInBrowserHatch";

// The key IS the assertion here. Copy lives in the locale files and is covered by
// the i18n guard; what this component must get right is WHICH sentence it shows
// in which state, and a key says that without pinning a translation.
vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

const reportCheckoutClientEvent = vi.hoisted(() => vi.fn());
vi.mock("@/lib/telemetry/checkoutClientEvent", () => ({ reportCheckoutClientEvent }));
const diagnosticReporter = vi.hoisted(() => ({ reportCustomerJourneyDiagnostic: vi.fn() }));
const diagnosticActionKey = "11111111-1111-4111-8111-111111111111";
vi.mock("@/lib/flags", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/flags")>();
  return {
    ...actual,
    createCustomerDiagnosticActionKeyWhenEnabled: vi.fn(() => diagnosticActionKey),
    loadCustomerDiagnosticReporterWhenEnabled: vi.fn(() => Promise.resolve(diagnosticReporter)),
  };
});

const FB_IOS = "Mozilla/5.0 (iPhone; CPU iPhone OS 16_7 like Mac OS X) [FBAN/FBIOS;FBAV/470.0.0.36.109]";
const DESKTOP = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/147.0.0.0 Safari/537.36";

const realUserAgent = window.navigator.userAgent;

function useUserAgent(value: string) {
  Object.defineProperty(window.navigator, "userAgent", { value, configurable: true });
}

beforeEach(() => {
  reportCheckoutClientEvent.mockReset();
  diagnosticReporter.reportCustomerJourneyDiagnostic.mockReset();
  resetFinishInBrowserHatchForTests();
});

afterEach(() => {
  useUserAgent(realUserAgent);
  vi.unstubAllGlobals();
});

describe("FinishInBrowserHatch", () => {
  it("is absent in a real browser", () => {
    // Nothing to escape from, so nothing on screen and nothing in the drain: the
    // `shown` count is the denominator of the whole measurement.
    useUserAgent(DESKTOP);

    const { container } = renderWithProviders(<FinishInBrowserHatch />);

    expect(container.firstChild).toBeNull();
    expect(reportCheckoutClientEvent).not.toHaveBeenCalled();
  });

  it("offers the way out inside an embedded webview, and counts the offer", () => {
    useUserAgent(FB_IOS);

    renderWithProviders(<FinishInBrowserHatch />);

    expect(screen.getByTestId("finish-in-browser")).toBeTruthy();
    expect(screen.getByTestId("finish-in-browser-action")).toBeTruthy();
    expect(reportCheckoutClientEvent).toHaveBeenCalledWith("escape_hatch", "shown");
  });

  it("asks for the link with the cookie and nothing else, then says where it went", async () => {
    useUserAgent(FB_IOS);
    const fetchMock = vi.fn().mockResolvedValue({ ok: true });
    vi.stubGlobal("fetch", fetchMock);

    renderWithProviders(<FinishInBrowserHatch />);
    fireEvent.click(screen.getByTestId("finish-in-browser-action"));

    const sent = await screen.findByTestId("finish-in-browser-sent");
    // ⛔ `credentials: "same-origin"` is the whole authority of the call: the
    // route reads the `HttpOnly` continuation cookie and the body is empty.
    expect(fetchMock).toHaveBeenCalledWith(CHECKOUT_PAYMENT_LINK_PATH, {
      method: "POST",
      credentials: "same-origin",
      headers: { "Content-Type": "application/json" },
      body: "{}",
    });
    // Both sentences, in the state that earns them: where the link went, and how
    // to leave the app it was opened in.
    expect(sent.textContent).toContain("checkout:finishInBrowser.sent");
    expect(sent.textContent).toContain("checkout:finishInBrowser.hint");
    expect(reportCheckoutClientEvent).toHaveBeenCalledWith("escape_hatch", "requested");
    expect(reportCheckoutClientEvent).toHaveBeenCalledWith("escape_hatch", "sent");
    await waitFor(() => expect(diagnosticReporter.reportCustomerJourneyDiagnostic).toHaveBeenCalledWith({
      action: "checkout_recovery_hatch", phase: "attempted", code: "observed", clientActionKey: diagnosticActionKey,
    }));
    expect(diagnosticReporter.reportCustomerJourneyDiagnostic).toHaveBeenCalledWith({
      action: "checkout_recovery_hatch", phase: "settled", code: "succeeded", clientActionKey: diagnosticActionKey,
    });
    // The control SURVIVES the send, re-labelled. A sent link is not a delivered
    // one, and the route's ten-minute bucket exists so the buyer it never reached
    // can ask again inside the same checkout.
    expect(screen.getByTestId("finish-in-browser-action").textContent)
      .toContain("checkout:finishInBrowser.resend");
  });

  it("lets a buyer whose e-mail never arrived ask again, and asks the route again", async () => {
    useUserAgent(FB_IOS);
    const fetchMock = vi.fn().mockResolvedValue({ ok: true });
    vi.stubGlobal("fetch", fetchMock);

    renderWithProviders(<FinishInBrowserHatch />);
    fireEvent.click(screen.getByTestId("finish-in-browser-action"));
    await screen.findByTestId("finish-in-browser-sent");

    fireEvent.click(screen.getByTestId("finish-in-browser-action"));

    // ⛔ A second REQUEST, not a swallowed tap. The client latch carries the
    // confirmation sentence across remounts; it must never become a client-side
    // rate limit on top of the server's own, which is idempotent by design.
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    expect(screen.getByTestId("finish-in-browser-sent")).toBeTruthy();
  });

  it("keeps the control usable when the route refuses, and claims nothing was sent", async () => {
    useUserAgent(FB_IOS);
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: false, status: 401 }));

    renderWithProviders(<FinishInBrowserHatch />);
    fireEvent.click(screen.getByTestId("finish-in-browser-action"));

    const failed = await screen.findByTestId("finish-in-browser-failed");
    expect(failed.textContent).toContain("checkout:finishInBrowser.failed");
    expect(screen.queryByTestId("finish-in-browser-sent")).toBeNull();
    // A dead button after a refusal is the silence this wave exists to end.
    expect(screen.getByTestId("finish-in-browser-action")).toHaveProperty("disabled", false);
    expect(reportCheckoutClientEvent).not.toHaveBeenCalledWith("escape_hatch", "sent");
    await waitFor(() => expect(diagnosticReporter.reportCustomerJourneyDiagnostic).toHaveBeenCalledWith({
      action: "checkout_recovery_hatch", phase: "settled", code: "rejected", clientActionKey: diagnosticActionKey,
    }));
  });

  it("reports a non-rejection response as a technical failure", async () => {
    useUserAgent(FB_IOS);
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: false, status: 503 }));

    renderWithProviders(<FinishInBrowserHatch />);
    fireEvent.click(screen.getByTestId("finish-in-browser-action"));

    await screen.findByTestId("finish-in-browser-failed");
    await waitFor(() => expect(diagnosticReporter.reportCustomerJourneyDiagnostic).toHaveBeenCalledWith({
      action: "checkout_recovery_hatch", phase: "settled", code: "failed", clientActionKey: diagnosticActionKey,
    }));
    expect(reportCheckoutClientEvent).not.toHaveBeenCalledWith("escape_hatch", "sent");
  });

  it("reports a rejected browser fetch as transport uncertainty", async () => {
    useUserAgent(FB_IOS);
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new TypeError("network")));

    renderWithProviders(<FinishInBrowserHatch />);
    fireEvent.click(screen.getByTestId("finish-in-browser-action"));

    await screen.findByTestId("finish-in-browser-failed");
    await waitFor(() => expect(diagnosticReporter.reportCustomerJourneyDiagnostic).toHaveBeenCalledWith({
      action: "checkout_recovery_hatch", phase: "settled", code: "transport_uncertain", clientActionKey: diagnosticActionKey,
    }));
    expect(reportCheckoutClientEvent).not.toHaveBeenCalledWith("escape_hatch", "sent");
  });

  it("stays sent across a remount, because the step it hangs on is replaced mid-flow", async () => {
    useUserAgent(FB_IOS);
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true }));

    const first = renderWithProviders(<FinishInBrowserHatch />);
    fireEvent.click(screen.getByTestId("finish-in-browser-action"));
    await waitFor(() => expect(screen.getByTestId("finish-in-browser-sent")).toBeTruthy());
    first.unmount();

    renderWithProviders(<FinishInBrowserHatch />);

    expect(screen.getByTestId("finish-in-browser-sent")).toBeTruthy();
    // Remounted into the SENT state, so the fresh "send me a link" label - the
    // one that would tell a buyer who already has the e-mail that nothing has
    // happened yet - never comes back with the new mount.
    expect(screen.getByTestId("finish-in-browser-action").textContent)
      .toContain("checkout:finishInBrowser.resend");
  });
});
