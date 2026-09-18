import { useEffect, useRef, useState } from "react";

const POLL_INTERVAL_MS = 1500;
const POLL_TIMEOUT_MS = 60_000;

export type PollerTerminalStatus = "paid" | "failed" | "expired" | "timeout";

export type PollerStatusKind = "pending_provider_action" | "requires_action" | "processing" | "paid" | "failed" | "expired";

/**
 * Provider-neutral status snapshot consumed by the poller. The caller adapts
 * its checkout-status response into this minimal shape so the poller stays
 * free of cross-domain imports (architecture guardrail).
 */
export interface PollerStatusSnapshot {
  status: PollerStatusKind;
  intentStatus?: string | null;
  /** Server-authoritative terminal observed by the host, before UI-specific mapping. */
  paymentTerminal?: Exclude<PollerTerminalStatus, "timeout">;
  /** Opaque host-owned continuation state; the poller never interprets it. */
  hostState?: string;
  /** Optional host-owned identifier paired with `hostState`. */
  hostReference?: string | null;
  /**
   * A host has synchronously recognized a long-lived state it owns. Once seen,
   * preserve polling beyond the generic confirmation ceiling even before React
   * can apply a new `timeoutMs` prop.
   */
  continuePastTimeout?: boolean;
}

export interface PaymentStatusPollerProps {
  orderId: string;
  paymentIntentId: string;
  clientId: string;
  /**
   * Fetcher injected by the caller. Receives the polling input and returns
   * the latest local status snapshot. Should throw on transport errors — the
   * poller swallows them and keeps polling until the timeout.
   */
  fetchStatus: (input: { orderId: string; paymentIntentId: string; clientId: string }) => Promise<PollerStatusSnapshot>;
  /** Runs only for an active mounted poller, after the latest snapshot is accepted. */
  onSnapshot?: (snapshot: PollerStatusSnapshot) => void;
  onTerminal: (status: PollerTerminalStatus, snapshot: PollerStatusSnapshot | null) => void;
  /**
   * Stops the poll when the parent unmounts or wants to bail mid-flight (e.g.
   * the user navigated away or `confirmPayment` failed before any inbound
   * webhook could land). Defaults to `false`.
   */
  paused?: boolean;
  /** `null` deliberately disables the ordinary 60s ceiling for a host-owned long wait. */
  timeoutMs?: number | null;
}

/**
 * Hidden poller (W11.7 Wave C) that fetches `/api/bff/commerce/payment-status`
 * every 1.5s until the local payment-control state reaches a terminal value or
 * the 60s timeout fires. The browser does NOT trust Stripe's inline status —
 * we always wait for payment-control to flip via the webhook (Wave B).
 *
 * Rendering: minimal "Czekamy na potwierdzenie…" spinner copy. Real UI is
 * still owned by the configurator step that mounts this poller.
 */
export function PaymentStatusPoller({
  orderId,
  paymentIntentId,
  clientId,
  fetchStatus,
  onSnapshot,
  onTerminal,
  paused = false,
  timeoutMs = POLL_TIMEOUT_MS,
}: PaymentStatusPollerProps) {
  const [latest, setLatest] = useState<PollerStatusSnapshot | null>(null);
  const settledRef = useRef(false);
  const timeoutMsRef = useRef(timeoutMs);
  const continuePastTimeoutRef = useRef(false);

  // Hosts may deliberately graduate an ordinary payment confirmation into a
  // longer-lived, domain-owned wait (for example recurring-mandate
  // activation). Updating this ref avoids restarting the poller and issuing an
  // extra immediate read just because its timeout policy changed.
  useEffect(() => {
    timeoutMsRef.current = timeoutMs;
  }, [timeoutMs]);

  useEffect(() => {
    if (paused) return;
    settledRef.current = false;
    continuePastTimeoutRef.current = false;
    let active = true;
    const startedAt = Date.now();
    let timer: ReturnType<typeof setTimeout> | undefined;

    const tick = async () => {
      if (!active || settledRef.current) return;
      try {
        const snapshot = await fetchStatus({ orderId, paymentIntentId, clientId });
        if (!active) return;
        setLatest(snapshot);
        onSnapshot?.(snapshot);
        // This must happen before the generic timeout test below. A host might
        // discover its long-lived state on the exact poll that reaches 60s;
        // waiting for a React re-render would incorrectly finalize timeout.
        if (snapshot.continuePastTimeout) continuePastTimeoutRef.current = true;
        if (snapshot.status === "paid") return finalize("paid", snapshot);
        if (snapshot.status === "failed") return finalize("failed", snapshot);
        if (snapshot.status === "expired") return finalize("expired", snapshot);
      } catch {
        // Transient errors keep the loop alive — the timeout below is the
        // hard ceiling so a flaky network does not pin the user forever.
      }
      if (
        !continuePastTimeoutRef.current
        && timeoutMsRef.current !== null
        && Date.now() - startedAt >= timeoutMsRef.current
      ) {
        return finalize("timeout", null);
      }
      timer = setTimeout(tick, POLL_INTERVAL_MS);
    };

    const finalize = (status: PollerTerminalStatus, snapshot: PollerStatusSnapshot | null) => {
      if (settledRef.current) return;
      settledRef.current = true;
      onTerminal(status, snapshot);
    };

    tick();
    return () => {
      active = false;
      if (timer) clearTimeout(timer);
    };
  }, [clientId, fetchStatus, onSnapshot, onTerminal, orderId, paused, paymentIntentId]);

  return (
    <p role="status" className="text-center text-sm text-muted-foreground">
      Czekamy na potwierdzenie płatności
      {latest?.intentStatus ? ` (${latest.intentStatus})` : ""}…
    </p>
  );
}
