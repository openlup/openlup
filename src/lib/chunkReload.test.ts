/** @vitest-environment jsdom */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  installChunkReloadHandler,
  isTaggedModuleFailure,
  isTransientModuleError,
  markModuleFailure,
  shouldReloadForChunkError,
} from "./chunkReload";

const COOLDOWN = 10_000;

describe("isTransientModuleError", () => {
  it("does not infer module provenance from untagged default-property reads", () => {
    expect(
      isTransientModuleError(
        new Error("Cannot read properties of undefined (reading 'default')"),
      ),
    ).toBe(false);
    expect(
      isTransientModuleError(
        new TypeError("undefined is not an object (evaluating 'n.default')"),
      ),
    ).toBe(false);
  });

  it("classifies Vite/browser dynamic-import failures as transient", () => {
    expect(
      isTransientModuleError(new Error("Failed to fetch dynamically imported module: /assets/x.js")),
    ).toBe(true);
    expect(isTransientModuleError(new Error("error loading dynamically imported module"))).toBe(true);
    expect(isTransientModuleError(new Error("importing a module script failed"))).toBe(true);
    const chunkErr = new Error("loading chunk 42 failed");
    chunkErr.name = "ChunkLoadError";
    expect(isTransientModuleError(chunkErr)).toBe(true);
  });

  it("does not misclassify an ordinary application error as transient", () => {
    expect(isTransientModuleError(new Error("Cannot read properties of null (reading 'id')"))).toBe(
      false,
    );
    expect(isTransientModuleError(new TypeError("orders.map is not a function"))).toBe(false);
    expect(isTransientModuleError(undefined)).toBe(false);
    expect(isTransientModuleError(null)).toBe(false);
  });

  it("does not treat an undefined read on a named property as a module failure", () => {
    expect(
      isTransientModuleError(
        new Error("Cannot read properties of undefined (reading 'customerEmail')"),
      ),
    ).toBe(false);
    expect(
      isTransientModuleError(new Error("Cannot read properties of undefined (reading 'orderId')")),
    ).toBe(false);
    expect(
      isTransientModuleError(new Error("Cannot read properties of undefined (reading 'address')")),
    ).toBe(false);
  });

  it("classifies direct module-failure evidence regardless of message wording", () => {
    const tagged = markModuleFailure(
      new Error("Cannot read properties of undefined (reading 'customerEmail')"),
    );
    expect(isTransientModuleError(tagged)).toBe(true);
    expect(
      isTransientModuleError(
        new Error("Cannot read properties of undefined (reading 'customerEmail')"),
      ),
    ).toBe(false);
  });
});

describe("markModuleFailure", () => {
  it("tags the error object without changing its serializable shape", () => {
    const error = new Error("boom");
    expect(markModuleFailure(error)).toBe(error);
    expect(error.message).toBe("boom");
    expect(isTaggedModuleFailure(error)).toBe(true);
    expect(JSON.stringify({ ...error })).not.toMatch(/module/i);
    expect(Object.keys(error)).toHaveLength(0);
  });

  it("wraps non-object thrown values so they can carry evidence", () => {
    const wrapped = markModuleFailure("Failed to fetch dynamically imported module");
    expect(wrapped).toBeInstanceOf(Error);
    expect(isTaggedModuleFailure(wrapped)).toBe(true);
    expect(isTransientModuleError(wrapped)).toBe(true);
    expect(isTransientModuleError(markModuleFailure(undefined))).toBe(true);
  });

  it("preserves identity for plain objects and functions", () => {
    const plain = { reason: "cross-realm-compatible" };
    const callable = () => undefined;

    expect(markModuleFailure(plain)).toBe(plain);
    expect(isTaggedModuleFailure(plain)).toBe(true);
    expect(markModuleFailure(callable)).toBe(callable);
    expect(isTaggedModuleFailure(callable)).toBe(true);
  });

  it("does not tag unrelated errors", () => {
    expect(isTaggedModuleFailure(new Error("boom"))).toBe(false);
    expect(isTaggedModuleFailure("boom")).toBe(false);
    expect(isTaggedModuleFailure(null)).toBe(false);
  });
});

describe("installChunkReloadHandler", () => {
  let reload: ReturnType<typeof vi.fn>;
  let originalLocation: Location;

  beforeEach(() => {
    window.sessionStorage.clear();
    reload = vi.fn();
    originalLocation = window.location;
    Object.defineProperty(window, "location", {
      configurable: true,
      value: { ...originalLocation, reload },
    });
  });

  afterEach(() => {
    Object.defineProperty(window, "location", {
      configurable: true,
      value: originalLocation,
    });
    window.sessionStorage.clear();
  });

  function dispatchPreloadError(): Event {
    const event = new Event("vite:preloadError", { cancelable: true });
    window.dispatchEvent(event);
    return event;
  }

  it("prevents Vite's rethrow only when a reload fires", () => {
    installChunkReloadHandler();

    const event = dispatchPreloadError();
    expect(reload).toHaveBeenCalledTimes(1);
    expect(event.defaultPrevented).toBe(true);
  });

  it("lets the failure propagate when cooldown suppresses the reload", () => {
    installChunkReloadHandler();

    dispatchPreloadError();
    reload.mockClear();

    const event = dispatchPreloadError();
    expect(reload).not.toHaveBeenCalled();
    expect(event.defaultPrevented).toBe(false);
  });
});

describe("shouldReloadForChunkError", () => {
  it("reloads when there is no prior reload", () => {
    expect(shouldReloadForChunkError(1_000, null)).toBe(true);
  });

  it("reloads when a corrupt timestamp was stored", () => {
    expect(shouldReloadForChunkError(1_000, Number.NaN)).toBe(true);
  });

  it("does not reload again within the cooldown (loop guard)", () => {
    expect(shouldReloadForChunkError(5_000, 5_000)).toBe(false);
    expect(shouldReloadForChunkError(5_000 + COOLDOWN - 1, 5_000)).toBe(false);
  });

  it("reloads again once the cooldown has elapsed", () => {
    expect(shouldReloadForChunkError(5_000 + COOLDOWN, 5_000)).toBe(true);
  });
});
