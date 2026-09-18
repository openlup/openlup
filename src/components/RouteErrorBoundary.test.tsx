import { render, screen, waitFor } from "@testing-library/react";
import { Suspense } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { lazyRoute } from "@/lib/lazyRoute";

import RouteErrorBoundary from "./RouteErrorBoundary";

vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (_key: string, opts?: { defaultValue?: string }) => opts?.defaultValue ?? _key,
  }),
}));

const reportCheckoutClientEvent = vi.hoisted(() => vi.fn());
const diagnosticReporter = vi.hoisted(() => ({ reportCustomerJourneyDiagnostic: vi.fn() }));
vi.mock("@/lib/telemetry/checkoutClientEvent", () => ({ reportCheckoutClientEvent }));
vi.mock("@/lib/flags", () => ({
  loadCustomerDiagnosticReporterWhenEnabled: () => Promise.resolve(diagnosticReporter),
}));

function Boom({ message }: { message: string }): JSX.Element {
  throw new Error(message);
}

describe("RouteErrorBoundary", () => {
  const originalError = console.error;

  beforeEach(() => {
    // React logs the caught error to console.error; keep the test output clean.
    console.error = vi.fn();
    reportCheckoutClientEvent.mockReset();
    diagnosticReporter.reportCustomerJourneyDiagnostic.mockReset();
    try {
      window.sessionStorage.clear();
    } catch {
      /* jsdom always has sessionStorage; ignore */
    }
  });

  afterEach(() => {
    console.error = originalError;
    vi.restoreAllMocks();
  });

  it("renders a recovery affordance when a child throws a non-transient error", () => {
    render(
      <RouteErrorBoundary>
        <Boom message="totally unrelated render bug" />
      </RouteErrorBoundary>,
    );

    expect(screen.getByTestId("route-error-boundary")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Odśwież stronę/i })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Spróbuj ponownie/i })).toBeInTheDocument();
  });

  it("renders children when they do not throw", () => {
    render(
      <RouteErrorBoundary>
        <div data-testid="ok">healthy</div>
      </RouteErrorBoundary>,
    );

    expect(screen.getByTestId("ok")).toBeInTheDocument();
    expect(screen.queryByTestId("route-error-boundary")).not.toBeInTheDocument();
  });

  // P6: a crash that auto-reloads leaves no other trace at all — the page
  // recovers and only this line remembers it had to.
  it("reports a render crash without letting the error text leave the browser", () => {
    render(
      <RouteErrorBoundary>
        <Boom message="Cannot read properties of undefined (reading 'customerEmail')" />
      </RouteErrorBoundary>,
    );

    expect(reportCheckoutClientEvent).toHaveBeenCalledWith("route_error", "render_crash");
    expect(reportCheckoutClientEvent).toHaveBeenCalledTimes(1);
    for (const call of reportCheckoutClientEvent.mock.calls) {
      expect(JSON.stringify(call)).not.toContain("customerEmail");
    }
  });

  it("records the closed route-render diagnostic on a customer crash", async () => {
    render(
      <RouteErrorBoundary>
        <Boom message="route failure" />
      </RouteErrorBoundary>,
    );

    await waitFor(() => expect(diagnosticReporter.reportCustomerJourneyDiagnostic).toHaveBeenCalledWith(
      { action: "route_render", phase: "settled", code: "render_failed" }, null,
    ));
  });

  // An admin tab left open across a release crashes on a chunk hash the new
  // deployment stopped serving, reloads and recovers. The event carries no path,
  // so before this gate the render-crash monitor paged for a tab that had
  // already fixed itself and no buyer had seen.
  it("does not report a render crash that happened on the admin surface", () => {
    const originalLocation = window.location;
    Object.defineProperty(window, "location", {
      configurable: true,
      value: { ...originalLocation, pathname: "/admin/zamowienia", reload: vi.fn() },
    });

    try {
      render(
        <RouteErrorBoundary>
          <Boom message="totally unrelated render bug" />
        </RouteErrorBoundary>,
      );

      expect(reportCheckoutClientEvent).not.toHaveBeenCalled();
      // The recovery affordance is unchanged: an admin crash still gets a way out.
      expect(screen.getByTestId("route-error-boundary")).toBeInTheDocument();
    } finally {
      Object.defineProperty(window, "location", {
        configurable: true,
        value: originalLocation,
      });
    }
  });

  it("reports a render crash on a customer route the admin gate must not swallow", () => {
    const originalLocation = window.location;
    Object.defineProperty(window, "location", {
      configurable: true,
      value: { ...originalLocation, pathname: "/konto/zamowienie/status", reload: vi.fn() },
    });

    try {
      render(
        <RouteErrorBoundary>
          <Boom message="totally unrelated render bug" />
        </RouteErrorBoundary>,
      );

      expect(reportCheckoutClientEvent).toHaveBeenCalledWith("route_error", "render_crash");
      expect(reportCheckoutClientEvent).toHaveBeenCalledTimes(1);
    } finally {
      Object.defineProperty(window, "location", {
        configurable: true,
        value: originalLocation,
      });
    }
  });

  it("stays silent when children render normally", () => {
    render(
      <RouteErrorBoundary>
        <div data-testid="ok">healthy</div>
      </RouteErrorBoundary>,
    );

    expect(reportCheckoutClientEvent).not.toHaveBeenCalled();
  });

  it("shows the card for an untagged default-property read", () => {
    const reload = vi.fn();
    const originalLocation = window.location;
    Object.defineProperty(window, "location", {
      configurable: true,
      value: { ...originalLocation, reload },
    });

    try {
      render(
        <RouteErrorBoundary>
          <Boom message="Cannot read properties of undefined (reading 'default')" />
        </RouteErrorBoundary>,
      );

      expect(reload).not.toHaveBeenCalled();
      expect(screen.getByTestId("route-error-boundary")).toBeInTheDocument();
      expect(reportCheckoutClientEvent).toHaveBeenCalledWith("route_error", "render_crash");
    } finally {
      Object.defineProperty(window, "location", {
        configurable: true,
        value: originalLocation,
      });
    }
  });

  it("reloads a tagged lazyRoute loader failure end to end", async () => {
    const reload = vi.fn();
    const originalLocation = window.location;
    Object.defineProperty(window, "location", {
      configurable: true,
      value: { ...originalLocation, reload },
    });

    try {
      const Broken = lazyRoute(() =>
        Promise.reject(new Error("Cannot read properties of undefined (reading 'customerEmail')")),
      );

      render(
        <RouteErrorBoundary>
          <Suspense fallback={<div data-testid="loading" />}>
            <Broken />
          </Suspense>
        </RouteErrorBoundary>,
      );

      await waitFor(() => expect(reload).toHaveBeenCalledTimes(1));
      expect(screen.queryByTestId("route-error-boundary")).not.toBeInTheDocument();
    } finally {
      Object.defineProperty(window, "location", {
        configurable: true,
        value: originalLocation,
      });
    }
  });

  it.each([null, undefined])(
    "reloads when lazyRoute resolves a %s default export",
    async (missingDefault) => {
      const reload = vi.fn();
      const originalLocation = window.location;
      Object.defineProperty(window, "location", {
        configurable: true,
        value: { ...originalLocation, reload },
      });

      try {
        const Broken = lazyRoute(async () => ({
          default: missingDefault as unknown as () => JSX.Element,
        }));

        render(
          <RouteErrorBoundary>
            <Suspense fallback={<div data-testid="loading" />}>
              <Broken />
            </Suspense>
          </RouteErrorBoundary>,
        );

        await waitFor(() => expect(reload).toHaveBeenCalledTimes(1));
        expect(screen.queryByTestId("route-error-boundary")).not.toBeInTheDocument();
      } finally {
        Object.defineProperty(window, "location", {
          configurable: true,
          value: originalLocation,
        });
      }
    },
  );

  it("shows the card for a bare undefined named-property read", () => {
    const reload = vi.fn();
    const originalLocation = window.location;
    Object.defineProperty(window, "location", {
      configurable: true,
      value: { ...originalLocation, reload },
    });

    try {
      render(
        <RouteErrorBoundary>
          <Boom message="Cannot read properties of undefined (reading 'customerEmail')" />
        </RouteErrorBoundary>,
      );

      expect(reload).not.toHaveBeenCalled();
      expect(screen.getByTestId("route-error-boundary")).toBeInTheDocument();
      expect(reportCheckoutClientEvent).toHaveBeenCalledWith("route_error", "render_crash");
      for (const call of reportCheckoutClientEvent.mock.calls) {
        expect(JSON.stringify(call)).not.toContain("customerEmail");
      }
    } finally {
      Object.defineProperty(window, "location", {
        configurable: true,
        value: originalLocation,
      });
    }
  });
});
