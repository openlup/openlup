import { act, renderHook, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

async function loadUseToastModule() {
  vi.resetModules();
  return import("@/hooks/use-toast");
}

describe("use-toast", () => {
  it("adds a toast, updates it, and dismisses it through the exported helpers", async () => {
    const { useToast, toast } = await loadUseToastModule();
    const { result } = renderHook(() => useToast());

    expect(result.current.toasts).toHaveLength(0);

    let api!: ReturnType<typeof toast>;
    act(() => {
      api = toast({
        title: "Hello",
        description: "World",
      });
    });

    await waitFor(() => {
      expect(result.current.toasts).toHaveLength(1);
    });
    expect(result.current.toasts[0]).toMatchObject({
      id: api.id,
      title: "Hello",
      description: "World",
      open: true,
    });

    act(() => {
      api.update({
        id: api.id,
        title: "Updated",
      } as never);
    });

    await waitFor(() => {
      expect(result.current.toasts[0]).toMatchObject({
        id: api.id,
        title: "Updated",
      });
    });

    act(() => {
      api.dismiss();
    });

    await waitFor(() => {
      expect(result.current.toasts[0]?.open).toBe(false);
    });
  });

  it("enforces the toast limit and dismisses all toasts from the hook API", async () => {
    const { useToast, toast } = await loadUseToastModule();
    const { result } = renderHook(() => useToast());

    act(() => {
      toast({ title: "First" });
      toast({ title: "Second" });
    });

    await waitFor(() => {
      expect(result.current.toasts).toHaveLength(1);
    });
    expect(result.current.toasts[0].title).toBe("Second");

    act(() => {
      result.current.dismiss();
    });

    await waitFor(() => {
      expect(result.current.toasts[0]?.open).toBe(false);
    });
  });

  it("handles reducer transitions for remove and dismiss actions", async () => {
    const { reducer } = await loadUseToastModule();

    const state = {
      toasts: [
        { id: "1", open: true, title: "One" },
        { id: "2", open: true, title: "Two" },
      ],
    };

    expect(
      reducer(state as never, {
        type: "REMOVE_TOAST",
        toastId: "1",
      } as never),
    ).toEqual({
      toasts: [{ id: "2", open: true, title: "Two" }],
    });

    expect(
      reducer(state as never, {
        type: "REMOVE_TOAST",
      } as never),
    ).toEqual({
      toasts: [],
    });

    const dismissed = reducer(state as never, {
      type: "DISMISS_TOAST",
    } as never);

    expect(dismissed.toasts).toEqual([
      { id: "1", open: false, title: "One" },
      { id: "2", open: false, title: "Two" },
    ]);
  });

  it("schedules removal only once when dismissing the same toast repeatedly", async () => {
    vi.useFakeTimers();
    const setTimeoutSpy = vi.spyOn(globalThis, "setTimeout");
    const { useToast, toast } = await loadUseToastModule();
    renderHook(() => useToast());

    let api!: ReturnType<typeof toast>;
    act(() => {
      api = toast({ title: "Queued" });
    });

    act(() => {
      api.dismiss();
      api.dismiss();
    });

    expect(setTimeoutSpy).toHaveBeenCalledTimes(1);

    setTimeoutSpy.mockRestore();
    vi.useRealTimers();
  });
});
