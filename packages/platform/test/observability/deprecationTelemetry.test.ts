import { afterEach, describe, expect, it, vi } from "vitest";
import {
  __resetDeprecationNoticeRegistryForTests,
  emitDeprecationNoticeOnce,
  type DeprecationNoticeEvent,
} from "../../src/observability/index.js";

afterEach(() => {
  __resetDeprecationNoticeRegistryForTests();
  vi.restoreAllMocks();
});

describe("emitDeprecationNoticeOnce", () => {
  it("emits once per (subpath, symbol, removeIn) tuple in the process registry", () => {
    const events: DeprecationNoticeEvent[] = [];
    const sink = (event: DeprecationNoticeEvent) => {
      events.push(event);
    };

    expect(
      emitDeprecationNoticeOnce(
        {
          symbol: "legacyFactory",
          subpath: "@openlup/platform/payments/tpay",
          replacement: "createTpayPaymentAdapter",
          removeIn: "2.0.0",
        },
        sink,
      ),
    ).toBe(true);

    expect(
      emitDeprecationNoticeOnce(
        {
          symbol: "legacyFactory",
          subpath: "@openlup/platform/payments/tpay",
          replacement: "createTpayPaymentAdapter",
          removeIn: "2.0.0",
        },
        sink,
      ),
    ).toBe(false);

    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      kind: "deprecation",
      symbol: "legacyFactory",
      subpath: "@openlup/platform/payments/tpay",
      replacement: "createTpayPaymentAdapter",
      removeIn: "2.0.0",
    });
    expect(events[0]!.message).toContain("legacyFactory");
    expect(events[0]!.message).toContain("createTpayPaymentAdapter");
    expect(events[0]!.message).toContain("2.0.0");
    expect(Number.isNaN(Date.parse(events[0]!.timestamp))).toBe(false);
  });

  it("isolates deduplication when an explicit Set registry is injected", () => {
    const registryA = new Set<string>();
    const registryB = new Set<string>();
    const events: DeprecationNoticeEvent[] = [];
    const notice = {
      symbol: "oldHelper",
      subpath: "@openlup/platform/observability",
      removeIn: "2.0.0",
    };

    expect(emitDeprecationNoticeOnce(notice, (e) => events.push(e), registryA)).toBe(true);
    expect(emitDeprecationNoticeOnce(notice, (e) => events.push(e), registryA)).toBe(false);
    expect(emitDeprecationNoticeOnce(notice, (e) => events.push(e), registryB)).toBe(true);
    // Process-wide default registry was not mutated.
    expect(emitDeprecationNoticeOnce(notice, (e) => events.push(e))).toBe(true);
    expect(events).toHaveLength(3);
    expect(events[0]).not.toHaveProperty("replacement");
  });

  it("resets the process-wide registry via __resetDeprecationNoticeRegistryForTests", () => {
    const emit = vi.fn();
    const notice = {
      symbol: "oldSymbol",
      subpath: "@openlup/platform/payments",
      removeIn: "2.0.0",
    };

    expect(emitDeprecationNoticeOnce(notice, emit)).toBe(true);
    expect(emitDeprecationNoticeOnce(notice, emit)).toBe(false);
    __resetDeprecationNoticeRegistryForTests();
    expect(emitDeprecationNoticeOnce(notice, emit)).toBe(true);
    expect(emit).toHaveBeenCalledTimes(2);
  });

  it("is 100% fail-open when the emitter throws synchronously or rejects asynchronously", async () => {
    const registry = new Set<string>();
    const throwingSink = vi.fn(() => {
      throw new Error("sink_exploded");
    });

    expect(() =>
      emitDeprecationNoticeOnce(
        {
          symbol: "brokenSync",
          subpath: "@openlup/platform/payments",
          removeIn: "2.0.0",
        },
        throwingSink,
        registry,
      ),
    ).not.toThrow();

    expect(
      emitDeprecationNoticeOnce(
        {
          symbol: "brokenSync",
          subpath: "@openlup/platform/payments",
          removeIn: "2.0.0",
        },
        throwingSink,
        registry,
      ),
    ).toBe(false);
    // Key was recorded before the throw so the broken emitter is not called again.
    expect(throwingSink).toHaveBeenCalledTimes(1);

    const rejectingSink = vi.fn(async () => {
      throw new Error("async_sink_exploded");
    }) as unknown as (event: DeprecationNoticeEvent) => void;

    expect(
      emitDeprecationNoticeOnce(
        {
          symbol: "brokenAsync",
          subpath: "@openlup/platform/payments",
          removeIn: "2.0.0",
        },
        rejectingSink,
        registry,
      ),
    ).toBe(true);
    await Promise.resolve();
    expect(rejectingSink).toHaveBeenCalledTimes(1);
  });

  it("enforces zero-PII scrubbing and drops unknown extra fields", () => {
    const registry = new Set<string>();
    const emitted: DeprecationNoticeEvent[] = [];
    const pollutedInput = {
      symbol: "legacy user@example.com Bearer supersecret12345",
      subpath: "@openlup/platform/payments",
      replacement: "newApi for buyer@example.org",
      removeIn: "2.0.0",
      email: "customer@example.com",
      authorization: "Bearer topsecret999999",
    };

    expect(
      emitDeprecationNoticeOnce(
        pollutedInput as Parameters<typeof emitDeprecationNoticeOnce>[0],
        (event) => emitted.push(event),
        registry,
      ),
    ).toBe(true);

    expect(emitted).toHaveLength(1);
    const serialized = JSON.stringify(emitted[0]);
    expect(serialized).not.toContain("user@example.com");
    expect(serialized).not.toContain("buyer@example.org");
    expect(serialized).not.toContain("customer@example.com");
    expect(serialized).not.toContain("supersecret12345");
    expect(serialized).not.toContain("topsecret999999");
    expect(emitted[0]).not.toHaveProperty("email");
    expect(emitted[0]).not.toHaveProperty("authorization");
    expect(emitted[0]!.symbol).toContain("[redacted_email]");
    expect(emitted[0]!.symbol).toContain("[redacted_auth]");
  });

  it("skips blank required fields and falls back safely to console.warn when no emitter is given", () => {
    const registry = new Set<string>();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    expect(
      emitDeprecationNoticeOnce(
        { symbol: "   ", subpath: "@openlup/platform/payments", removeIn: "2.0.0" },
        undefined,
        registry,
      ),
    ).toBe(false);
    expect(warn).not.toHaveBeenCalled();

    expect(
      emitDeprecationNoticeOnce(
        { symbol: "legacyFn", subpath: "@openlup/platform/payments", removeIn: "2.0.0" },
        undefined,
        registry,
      ),
    ).toBe(true);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0]![0]).toContain("legacyFn");

    warn.mockImplementation(() => {
      throw new Error("console_unavailable");
    });
    expect(
      emitDeprecationNoticeOnce(
        { symbol: "legacyFn2", subpath: "@openlup/platform/payments", removeIn: "2.0.0" },
        undefined,
        registry,
      ),
    ).toBe(false);
  });
});
