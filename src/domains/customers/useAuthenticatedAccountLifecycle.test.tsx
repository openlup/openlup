// @vitest-environment jsdom
import { act, renderHook, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { describe, expect, it, vi } from "vitest";

import { useAuthenticatedAccountLifecycle, type AccountLifecycleEvent } from "./useAuthenticatedAccountLifecycle";

type Account = { subscriptionId: string; nextCycleAt: string };
type Action = "account_mutation" | "subscription_mutation" | "account_refresh";

function fixture(readAccount: (token: string) => Promise<Account>, accessToken: string | null = "secret-token") {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const onEvent = vi.fn<(event: AccountLifecycleEvent<Action>) => void>();
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={client}>{children}</QueryClientProvider>
  );
  const hook = () => useAuthenticatedAccountLifecycle<Account, Action>({
    accessToken,
    principalId: "buyer-1",
    queryKey: ["account", "buyer-1"],
    readAccount,
    staleTime: 30_000,
    refetchInterval: () => false,
    defaultAction: "account_mutation",
    refreshAction: "account_refresh",
    createActionKey: () => "key-1",
    onEvent,
    classifyWriteError: () => "rejected",
    relatedRequestId: () => "request-1",
  });
  return { client, onEvent, wrapper, hook };
}

describe("useAuthenticatedAccountLifecycle", () => {
  it("loads only for an authenticated principal and never puts the token in cache identity or events", async () => {
    const read = vi.fn().mockResolvedValue({ subscriptionId: "s1", nextCycleAt: "2026-10-10" });
    const active = fixture(read);
    const view = renderHook(active.hook, { wrapper: active.wrapper });
    await waitFor(() => expect(view.result.current.loadState).toBe("ready"));
    expect(read).toHaveBeenCalledWith("secret-token");
    expect(active.client.getQueryCache().getAll().map((query) => query.queryKey)).toEqual([["account", "buyer-1"]]);
    expect(JSON.stringify(active.client.getQueryCache().getAll().map((query) => query.queryKey))).not.toContain("secret-token");
    expect(active.onEvent).not.toHaveBeenCalled();
    view.unmount();

    const idle = fixture(read, null);
    const idleView = renderHook(idle.hook, { wrapper: idle.wrapper });
    expect(idleView.result.current.loadState).toBe("idle");
    expect(read).toHaveBeenCalledTimes(1);
    await act(async () => {
      expect(await idleView.result.current.refresh()).toEqual({ ok: false, read: "skipped" });
      expect(await idleView.result.current.mutate(async () => undefined)).toEqual({ ok: false, write: "skipped", read: "not_attempted" });
    });
    expect(idle.onEvent).not.toHaveBeenCalled();
  });

  it("keeps cached account visible on a later read error and separates resolved invalidation from read failure", async () => {
    const read = vi.fn().mockResolvedValueOnce({ subscriptionId: "s1", nextCycleAt: "2026-10-10" })
      .mockRejectedValueOnce(new Error("temporary read failure"));
    const f = fixture(read);
    const view = renderHook(f.hook, { wrapper: f.wrapper });
    await waitFor(() => expect(view.result.current.loadState).toBe("ready"));

    let outcome;
    await act(async () => { outcome = await view.result.current.mutate(async () => undefined, "subscription_mutation"); });
    expect(outcome).toEqual({ ok: true, write: "succeeded", read: "stored_error" });
    expect(view.result.current.account).toEqual({ subscriptionId: "s1", nextCycleAt: "2026-10-10" });
    expect(view.result.current.loadState).toBe("ready");
    expect(f.onEvent.mock.calls.map(([event]) => [event.action, event.phase, event.code])).toEqual([
      ["subscription_mutation", "attempted", "observed"],
      ["subscription_mutation", "settled", "succeeded"],
      ["account_refresh", "refresh_started", "observed"],
      ["account_refresh", "refresh_settled", "refresh_failed"],
    ]);
    expect(JSON.stringify(f.onEvent.mock.calls)).not.toContain("secret-token");
  });

  it("refetches the changed account after a successful write", async () => {
    const before = { subscriptionId: "s1", nextCycleAt: "2026-10-10" };
    const after = { subscriptionId: "s1", nextCycleAt: "2026-10-17" };
    const read = vi.fn().mockResolvedValueOnce(before).mockResolvedValueOnce(after);
    const f = fixture(read);
    const view = renderHook(f.hook, { wrapper: f.wrapper });
    await waitFor(() => expect(view.result.current.account).toEqual(before));
    const work = vi.fn().mockResolvedValue(undefined);

    await act(async () => {
      expect(await view.result.current.mutate(work, "subscription_mutation")).toEqual({
        ok: true, write: "succeeded", read: "succeeded",
      });
    });

    expect(work).toHaveBeenCalledTimes(1);
    expect(read).toHaveBeenCalledTimes(2);
    await waitFor(() => expect(view.result.current.account).toEqual(after));
  });

  it("stops after a failed write and reports a rejected refresh separately from a successful write", async () => {
    const read = vi.fn().mockResolvedValue({ subscriptionId: "s1", nextCycleAt: "2026-10-10" });
    const f = fixture(read);
    const view = renderHook(f.hook, { wrapper: f.wrapper });
    await waitFor(() => expect(view.result.current.loadState).toBe("ready"));
    const invalidation = vi.spyOn(f.client, "invalidateQueries");
    let failedWrite;
    await act(async () => { failedWrite = await view.result.current.mutate(async () => { throw new Error("refused"); }); });
    expect(failedWrite).toEqual({ ok: false, write: "failed", read: "not_attempted" });
    expect(invalidation).not.toHaveBeenCalled();
    expect(f.onEvent.mock.lastCall?.[0]).toMatchObject({ phase: "settled", code: "rejected", relatedRequestId: "request-1" });

    invalidation.mockRejectedValueOnce(new Error("refresh failed"));
    let failedRead;
    await act(async () => { failedRead = await view.result.current.mutate(async () => undefined); });
    expect(failedRead).toEqual({ ok: false, write: "succeeded", read: "failed" });
    expect(f.onEvent.mock.calls.slice(-3).map(([event]) => event.phase)).toEqual(["settled", "refresh_started", "refresh_settled"]);
  });

  it("contains diagnostic callback and key-generation failures without changing the write or refresh", async () => {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const read = vi.fn().mockResolvedValue({ subscriptionId: "s1", nextCycleAt: "2026-10-10" });
    const wrapper = ({ children }: { children: ReactNode }) => <QueryClientProvider client={client}>{children}</QueryClientProvider>;
    const view = renderHook(() => useAuthenticatedAccountLifecycle<Account, Action>({
      accessToken: "secret-token",
      principalId: "buyer-1",
      queryKey: ["account", "buyer-1"],
      readAccount: read,
      staleTime: 30_000,
      defaultAction: "account_mutation",
      refreshAction: "account_refresh",
      createActionKey: () => { throw new Error("diagnostic key unavailable"); },
      onEvent: () => { throw new Error("diagnostic reporter unavailable"); },
    }), { wrapper });
    await waitFor(() => expect(view.result.current.loadState).toBe("ready"));
    await act(async () => {
      expect(await view.result.current.mutate(async () => undefined)).toEqual({ ok: true, write: "succeeded", read: "succeeded" });
    });
    expect(read).toHaveBeenCalledTimes(2);
  });
});
