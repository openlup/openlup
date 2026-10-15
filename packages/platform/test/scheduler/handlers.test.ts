import { describe, expect, it, vi } from "vitest";
import { mergeScheduledJobHandlers } from "../../src/scheduler/handlers.js";

describe("scheduled handler contributions", () => {
  it("merges in contribution order with the last binding winning", async () => {
    const first = vi.fn();
    const second = vi.fn();
    const last = vi.fn();
    const independent = vi.fn();
    const early = { "nightly-report": first, "queue-drain": independent };
    const result = mergeScheduledJobHandlers(early, { "nightly-report": second }, { "nightly-report": last });
    expect(Object.keys(result)).toEqual(["nightly-report", "queue-drain"]);
    expect(result["nightly-report"]).toBe(last);
    expect(result["queue-drain"]).toBe(independent);
    const invocation = { jobId: "nightly-report", invocationSource: "node_cron" as const };
    await result["nightly-report"]!(invocation);
    expect(last).toHaveBeenCalledExactlyOnceWith(invocation);
    expect(first).not.toHaveBeenCalled();
    expect(second).not.toHaveBeenCalled();
    expect(early).toEqual({ "nightly-report": first, "queue-drain": independent });
    expect(result).not.toBe(early);
  });

  it("ignores undefined contributions at every position", () => {
    const handler = vi.fn();
    expect(mergeScheduledJobHandlers(undefined, { "queue-drain": handler }, undefined, {}, undefined))
      .toEqual({ "queue-drain": handler });
    expect(mergeScheduledJobHandlers()).toEqual({});
    expect(mergeScheduledJobHandlers(undefined, undefined)).toEqual({});
  });

  it("preserves a later explicit undefined binding as an override", () => {
    const result = mergeScheduledJobHandlers({ "queue-drain": vi.fn() }, { "queue-drain": undefined });
    expect(Object.hasOwn(result, "queue-drain")).toBe(true);
    expect(result["queue-drain"]).toBeUndefined();
  });
});
