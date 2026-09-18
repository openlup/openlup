import { act, renderHook } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { useDebouncedValue } from "./useDebouncedValue";

describe("useDebouncedValue", () => {
  it("publishes the latest value after the debounce delay", () => {
    vi.useFakeTimers();
    try {
      const { result, rerender } = renderHook(
        ({ value }) => useDebouncedValue(value, 350),
        { initialProps: { value: "a" } },
      );

      rerender({ value: "ab" });
      rerender({ value: "abc" });

      expect(result.current).toBe("a");

      act(() => {
        vi.advanceTimersByTime(349);
      });
      expect(result.current).toBe("a");

      act(() => {
        vi.advanceTimersByTime(1);
      });
      expect(result.current).toBe("abc");
    } finally {
      vi.useRealTimers();
    }
  });
});
