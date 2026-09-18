import { useEffect, useRef } from "react";

export function useKioskIdle(
  onIdle: () => void,
  enabled: boolean,
  timeoutMs = 90_000,
): void {
  const timerRef = useRef<number | null>(null);
  const callbackRef = useRef(onIdle);
  callbackRef.current = onIdle;

  useEffect(() => {
    if (!enabled) {
      if (timerRef.current !== null) {
        window.clearTimeout(timerRef.current);
        timerRef.current = null;
      }
      return;
    }

    const reset = () => {
      if (timerRef.current !== null) window.clearTimeout(timerRef.current);
      timerRef.current = window.setTimeout(() => {
        callbackRef.current();
      }, timeoutMs);
    };

    reset();
    const events: (keyof WindowEventMap)[] = [
      "touchstart",
      "touchmove",
      "mousedown",
      "keydown",
      "pointerdown",
    ];
    for (const ev of events) window.addEventListener(ev, reset, { passive: true });

    return () => {
      if (timerRef.current !== null) window.clearTimeout(timerRef.current);
      for (const ev of events) window.removeEventListener(ev, reset);
    };
  }, [enabled, timeoutMs]);
}
