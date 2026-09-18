import { describe, expect, it } from "vitest";
import { appQueryClient, createAppQueryClient } from "./queryClient";

describe("appQueryClient", () => {
  it("uses request-hygiene defaults for app queries", () => {
    expect(appQueryClient.getDefaultOptions().queries).toMatchObject({
      staleTime: 60_000,
      refetchOnWindowFocus: false,
      refetchOnReconnect: true,
      retry: 1,
    });
  });

  it("creates isolated caches for concurrent static renders", () => {
    const first = createAppQueryClient();
    const second = createAppQueryClient();
    first.setQueryData(["route"], "first");

    expect(second).not.toBe(first);
    expect(second.getQueryData(["route"])).toBeUndefined();
  });
});
