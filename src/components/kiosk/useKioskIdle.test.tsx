import { act, renderHook } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { useKioskIdle } from "@/components/kiosk/useKioskIdle";

describe("useKioskIdle", () => {
  it("fires after the idle timeout and resets on interaction", () => {
    vi.useFakeTimers();
    const onIdle = vi.fn();

    const { unmount } = renderHook(() => useKioskIdle(onIdle, true, 100));

    act(() => {
      window.dispatchEvent(new Event("mousedown"));
      vi.advanceTimersByTime(99);
    });
    expect(onIdle).not.toHaveBeenCalled();

    act(() => vi.advanceTimersByTime(1));
    expect(onIdle).toHaveBeenCalledTimes(1);

    unmount();
    vi.useRealTimers();
  });

  it("does nothing while disabled", () => {
    vi.useFakeTimers();
    const onIdle = vi.fn();

    renderHook(() => useKioskIdle(onIdle, false, 100));

    act(() => vi.advanceTimersByTime(200));
    expect(onIdle).not.toHaveBeenCalled();
    vi.useRealTimers();
  });
});
