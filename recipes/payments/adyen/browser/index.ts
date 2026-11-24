/**
 * Browser-only Adyen Web Drop-in controller for the OpenLup Adyen Recipe.
 *
 * Provider recipe contract constraints:
 * - Zero Node built-ins and zero imports from `../server/**`.
 * - Zero ambient environment reads or global `<script>` tags.
 * - Exchanges neutral copy/settlement states with the host storefront and
 *   always exposes explicit degraded/fallback states (`unavailable`,
 *   `loading`, `ready`, `loadFailed`).
 * - Merge `browser/csp.json` into your host's Content-Security-Policy header.
 */

export type AdyenWebEnvironment = "test" | "live" | "live-us" | "live-au" | "live-in" | "live-apse";

export interface AdyenDropinCopy {
  unavailable: string;
  loading: string;
  loadFailed: string;
  loadRetry: string;
  loadAlternative?: string;
}

export type AdyenDropinViewState =
  | { status: "unavailable"; message: string }
  | { status: "loading"; message: string }
  | { status: "ready" }
  | { status: "loadFailed"; message: string; retryLabel: string; alternativeLabel?: string };

export type AdyenDropinSettlement =
  | { status: "submitted"; resultCode: string }
  | { status: "cancelled" }
  | { status: "failed"; code: string };

export interface AdyenSessionHandoffPayload {
  id: string;
  sessionData: string;
}

export interface AdyenDropinMountHandle {
  unmount(): void;
}

/** Narrow structural interface matching Adyen Web Drop-in v6 factory (`AdyenCheckout`). */
export interface AdyenWebCheckoutLoader {
  load(input: {
    environment: AdyenWebEnvironment;
    clientKey: string;
    session: AdyenSessionHandoffPayload;
    locale?: string;
    onPaymentCompleted(result: { resultCode?: string }): void;
    onError(error: { name?: string }): void;
  }): Promise<{
    mount(container: unknown): AdyenDropinMountHandle;
  }>;
}

export interface MountAdyenDropinInput {
  /** Transient handoff payload received in memory from the checkout BFF (never persisted). */
  handoffPayload: string | null | undefined;
  environment: AdyenWebEnvironment;
  clientKey: string;
  locale?: string;
  container: unknown;
  copy: AdyenDropinCopy;
  loader: AdyenWebCheckoutLoader | null;
  onStateChange(state: AdyenDropinViewState): void;
  onSettled(settlement: AdyenDropinSettlement): void;
}

/** Parses the transient `client-confirmed` handoff payload without logging or persisting it. */
export function parseAdyenSessionHandoff(raw: string | null | undefined): AdyenSessionHandoffPayload | null {
  if (typeof raw !== "string" || raw.trim().length === 0) return null;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
    const record = parsed as Record<string, unknown>;
    if (typeof record.id !== "string" || record.id.trim().length === 0) return null;
    if (typeof record.sessionData !== "string" || record.sessionData.trim().length === 0) return null;
    return { id: record.id, sessionData: record.sessionData };
  } catch {
    return null;
  }
}

/**
 * Lazily mounts Adyen Web Drop-in using an explicit loader and surfaces
 * degraded states cleanly if credentials, handoff, or remote script loading fail.
 */
export async function mountAdyenDropin(
  input: MountAdyenDropinInput,
): Promise<AdyenDropinMountHandle | null> {
  const session = parseAdyenSessionHandoff(input.handoffPayload);
  if (!session || !input.clientKey || !input.loader) {
    input.onStateChange({ status: "unavailable", message: input.copy.unavailable });
    return null;
  }

  input.onStateChange({ status: "loading", message: input.copy.loading });

  try {
    const checkout = await input.loader.load({
      environment: input.environment,
      clientKey: input.clientKey,
      session,
      locale: input.locale,
      onPaymentCompleted(result) {
        const resultCode = typeof result?.resultCode === "string" && result.resultCode.length > 0
          ? result.resultCode
          : "Pending";
        if (resultCode === "Cancelled") {
          input.onSettled({ status: "cancelled" });
          return;
        }
        // Browser completion is never terminal money truth; the server still
        // settles strictly from verified Adyen webhooks.
        input.onSettled({ status: "submitted", resultCode });
      },
      onError(error) {
        const code = typeof error?.name === "string" && /^[A-Za-z0-9_-]{1,64}$/u.test(error.name)
          ? error.name
          : "ADYEN_CLIENT_ERROR";
        input.onSettled({ status: "failed", code });
      },
    });
    const handle = checkout.mount(input.container);
    input.onStateChange({ status: "ready" });
    return handle;
  } catch {
    input.onStateChange({
      status: "loadFailed",
      message: input.copy.loadFailed,
      retryLabel: input.copy.loadRetry,
      ...(input.copy.loadAlternative ? { alternativeLabel: input.copy.loadAlternative } : {}),
    });
    return null;
  }
}
