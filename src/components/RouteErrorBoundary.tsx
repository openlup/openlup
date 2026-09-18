import { Component, type ErrorInfo, type ReactNode } from "react";
import { useTranslation } from "react-i18next";

import { isTransientModuleError, triggerGuardedReload } from "@/lib/chunkReload";
import { reportCheckoutClientEvent } from "@/lib/telemetry/checkoutClientEvent";
import { loadCustomerDiagnosticReporterWhenEnabled } from "@/lib/flags";

interface RouteErrorBoundaryProps {
  children: ReactNode;
}

/**
 * True unless the crash happened on the admin surface.
 *
 * ⛔ NOTHING HERE MAY THROW — it runs inside `componentDidCatch`, while the tree
 * is already broken. Every way of not knowing the path (no `window`, a getter
 * that refuses) resolves to reporting: an unreported crash is worse than an
 * extra one, and this gate exists to remove a known false page, not to be
 * clever about an unknown case.
 */
function isReportableCrashLocation(): boolean {
  try {
    if (typeof window === "undefined") return true;
    const pathname = window.location?.pathname;
    if (typeof pathname !== "string") return true;
    return pathname !== "/admin" && !pathname.startsWith("/admin/");
  } catch {
    return true;
  }
}

interface RouteErrorBoundaryState {
  error: Error | null;
  /** A one-shot guarded reload was already fired for the current error. */
  reloading: boolean;
}

/**
 * Top-level render error boundary for the routed tree.
 *
 * Before this existed a thrown render error inside the single `<Suspense>` had no
 * catcher, so the customer was stranded on the {@link PageLoader} spinner with no
 * way to recover. One common cause is a transient stale/partial lazy chunk
 * (see `chunkReload`) — e.g. an SPA transition to `/konto/zamowienie/status` right
 * after a payment redirect — which a fresh full-page load reliably recovers from.
 *
 * For those transient errors we fire one guarded auto-reload (loop-protected by the
 * shared cooldown). If the reload is suppressed (already reloaded) or the error is
 * not a module failure, we render a friendly fallback with a manual reload
 * affordance so the customer always has an on-screen way out.
 * Ordinary property reads from `undefined` are application bugs and reach the
 * card; only loader evidence or unambiguous chunk/import signatures auto-reload.
 */
export class RouteErrorBoundary extends Component<
  RouteErrorBoundaryProps,
  RouteErrorBoundaryState
> {
  state: RouteErrorBoundaryState = { error: null, reloading: false };

  static getDerivedStateFromError(error: Error): Partial<RouteErrorBoundaryState> {
    return { error };
  }

  componentDidCatch(error: Error, _info: ErrorInfo): void {
    // ⛔ THE ERROR ITSELF NEVER LEAVES THE BROWSER. Not the message, not the
    // stack, not the component trace. A render error's message routinely
    // interpolates the props that produced it, which on this tree means an
    // address, an email or an order — so the report is the FACT that a route
    // crashed, and nothing about which one or for whom. The auto-reload below
    // also means a crash can otherwise vanish without trace: the page recovers,
    // and only this line remembers that it had to.
    //
    // Not from the admin surface, though. An admin tab left open across a
    // release asks for a chunk hash the new deployment no longer serves, crashes
    // here, auto-reloads below and comes back healthy — it happened after each
    // of the last two promotions. The report carries no path, so the
    // render-crash monitor (threshold 0) reads those as a customer whose
    // checkout broke and pages for a tab that already fixed itself. The reload
    // is unchanged for both sides; only the telemetry is gated.
    if (isReportableCrashLocation()) {
      reportCheckoutClientEvent("route_error", "render_crash");
      reportDiagnostic();
    }
    if (isTransientModuleError(error)) {
      // A fresh full-page load recovers from a stale/partial chunk; fire one
      // guarded reload. If the guard suppresses it (already reloaded recently),
      // fall through to the manual fallback below.
      const reloading = triggerGuardedReload();
      if (reloading) this.setState({ reloading: true });
    }
  }

  private handleRetry = () => {
    this.setState({ error: null, reloading: false });
  };

  render(): ReactNode {
    if (this.state.error) {
      // While an auto-reload is in flight, keep the surface quiet (a flash of the
      // error card before the reload would be jarring).
      if (this.state.reloading) return null;
      return <RouteErrorFallback onRetry={this.handleRetry} />;
    }
    return this.props.children;
  }
}

function RouteErrorFallback({ onRetry }: { onRetry: () => void }) {
  const { t } = useTranslation("common");
  return (
    <div
      role="alert"
      data-testid="route-error-boundary"
      className="flex min-h-screen flex-col items-center justify-center gap-4 bg-background px-6 text-center text-foreground"
    >
      <h1 className="text-2xl font-semibold">
        {t("common:routeError.title", { defaultValue: "Coś poszło nie tak" })}
      </h1>
      <p className="max-w-md text-foreground/60">
        {t("common:routeError.body", {
          defaultValue:
            "Nie udało się w pełni załadować tej strony. Odśwież ją, aby spróbować ponownie.",
        })}
      </p>
      <div className="flex flex-wrap justify-center gap-3">
        <button
          type="button"
          onClick={() => window.location.reload()}
          className="rounded-full bg-primary px-6 py-2.5 font-semibold text-primary-foreground transition hover:opacity-90"
        >
          {t("common:routeError.reload", { defaultValue: "Odśwież stronę" })}
        </button>
        <button
          type="button"
          onClick={onRetry}
          className="rounded-full border border-foreground/15 px-6 py-2.5 font-semibold text-foreground transition hover:bg-foreground/5"
        >
          {t("common:routeError.retry", { defaultValue: "Spróbuj ponownie" })}
        </button>
      </div>
    </div>
  );
}

export default RouteErrorBoundary;

function reportDiagnostic(): void {
  void loadCustomerDiagnosticReporterWhenEnabled?.()?.then((reporter) => {
    reporter?.reportCustomerJourneyDiagnostic({
      action: "route_render",
      phase: "settled",
      code: "render_failed",
    }, null);
  });
}
