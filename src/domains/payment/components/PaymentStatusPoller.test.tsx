import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, cleanup, act } from "@testing-library/react";

import {
  PaymentStatusPoller,
  type PollerStatusSnapshot,
  type PollerTerminalStatus,
} from "./PaymentStatusPoller";

const INPUT = {
  orderId: "11111111-1111-4111-8111-111111111111",
  paymentIntentId: "22222222-2222-4222-8222-222222222222",
  clientId: "33333333-3333-4333-8333-333333333333",
};

describe("PaymentStatusPoller", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    cleanup();
    vi.useRealTimers();
  });

  it("finalizes with 'paid' as soon as the fetcher returns a paid snapshot", async () => {
    const snapshot: PollerStatusSnapshot = { status: "paid", intentStatus: "succeeded" };
    const fetchStatus = vi.fn().mockResolvedValue(snapshot);
    const onTerminal = vi.fn<(s: PollerTerminalStatus, snap: PollerStatusSnapshot | null) => void>();

    render(
      <PaymentStatusPoller
        {...INPUT}
        fetchStatus={fetchStatus}
        onTerminal={onTerminal}
      />,
    );

    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(fetchStatus).toHaveBeenCalledWith(INPUT);
    expect(onTerminal).toHaveBeenCalledWith("paid", snapshot);
  });

  it("keeps polling on transient errors until a terminal status arrives", async () => {
    const fetchStatus = vi
      .fn()
      .mockRejectedValueOnce(new Error("network blip"))
      .mockResolvedValueOnce({ status: "processing", intentStatus: "processing" } as PollerStatusSnapshot)
      .mockResolvedValueOnce({ status: "failed", intentStatus: "failed" } as PollerStatusSnapshot);
    const onTerminal = vi.fn<(s: PollerTerminalStatus, snap: PollerStatusSnapshot | null) => void>();

    render(
      <PaymentStatusPoller
        {...INPUT}
        fetchStatus={fetchStatus}
        onTerminal={onTerminal}
      />,
    );

    // initial tick
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(onTerminal).not.toHaveBeenCalled();

    // second tick: returns "processing", still not terminal
    await act(async () => {
      vi.advanceTimersByTime(1500);
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(onTerminal).not.toHaveBeenCalled();

    // third tick: returns "failed", terminal
    await act(async () => {
      vi.advanceTimersByTime(1500);
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(onTerminal).toHaveBeenCalledWith("failed", expect.objectContaining({ status: "failed" }));
  });

  it("renders a status hint with the latest intentStatus", async () => {
    const fetchStatus = vi
      .fn()
      .mockResolvedValueOnce({ status: "processing", intentStatus: "processing" } as PollerStatusSnapshot);

    render(
      <PaymentStatusPoller
        {...INPUT}
        fetchStatus={fetchStatus}
        onTerminal={vi.fn()}
      />,
    );

    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(screen.getByRole("status").textContent).toMatch(/processing/);
  });

  it("does not start polling while paused", async () => {
    const fetchStatus = vi.fn().mockResolvedValue({ status: "paid" } as PollerStatusSnapshot);
    const onTerminal = vi.fn();

    render(
      <PaymentStatusPoller
        {...INPUT}
        fetchStatus={fetchStatus}
        onTerminal={onTerminal}
        paused
      />,
    );

    await act(async () => {
      await Promise.resolve();
    });

    expect(fetchStatus).not.toHaveBeenCalled();
    expect(onTerminal).not.toHaveBeenCalled();
  });

  it("does not deliver a late snapshot after the poller unmounts", async () => {
    let resolveSnapshot: (snapshot: PollerStatusSnapshot) => void;
    const fetchStatus = vi.fn().mockReturnValue(new Promise<PollerStatusSnapshot>((resolve) => {
      resolveSnapshot = resolve;
    }));
    const onSnapshot = vi.fn();
    const onTerminal = vi.fn();
    const view = render(
      <PaymentStatusPoller
        {...INPUT}
        fetchStatus={fetchStatus}
        onSnapshot={onSnapshot}
        onTerminal={onTerminal}
      />,
    );

    view.unmount();
    await act(async () => {
      resolveSnapshot!({ status: "paid", paymentTerminal: "paid" });
      await Promise.resolve();
    });

    expect(onSnapshot).not.toHaveBeenCalled();
    expect(onTerminal).not.toHaveBeenCalled();
  });

  it("keeps polling past the default ceiling when a host explicitly disables the timeout", async () => {
    const fetchStatus = vi.fn().mockResolvedValue({ status: "processing" } as PollerStatusSnapshot);
    const onTerminal = vi.fn();

    render(
      <PaymentStatusPoller
        {...INPUT}
        fetchStatus={fetchStatus}
        onTerminal={onTerminal}
        timeoutMs={null}
      />,
    );

    await act(async () => {
      await vi.advanceTimersByTimeAsync(60_001);
    });

    expect(fetchStatus).toHaveBeenCalled();
    expect(onTerminal).not.toHaveBeenCalled();
  });
});
