/** @vitest-environment jsdom -- the boundary only exists for browser storage. */
import { afterEach, describe, expect, it } from "vitest";

import {
  createMemoryStorage,
  getBrowserStorage,
  readStorageItem,
  removeStorageItem,
  resolveStorageOrMemory,
  writeStorageItem,
} from "@/lib/browserStorage";

const DENIED = () => {
  throw new DOMException("The operation is insecure.", "SecurityError");
};

/**
 * The faithful imitation of a webview with site data denied: the PROPERTY
 * ACCESS throws, not `getItem`. A guard that only wraps the method call never
 * runs at all in this browser, which is the whole reason the boundary exists.
 */
function denyStorage(name: "localStorage" | "sessionStorage"): void {
  Object.defineProperty(window, name, { configurable: true, get: DENIED, set: DENIED });
}

const originals = new Map<string, PropertyDescriptor>();
for (const name of ["localStorage", "sessionStorage"] as const) {
  const descriptor = Object.getOwnPropertyDescriptor(window, name);
  if (descriptor) originals.set(name, descriptor);
}

afterEach(() => {
  for (const [name, descriptor] of originals) Object.defineProperty(window, name, descriptor);
});

describe("browserStorage", () => {
  it("reads and writes through to the real store when the browser allows it", () => {
    expect(writeStorageItem("localStorage", "probe", "kept")).toBe(true);
    expect(readStorageItem("localStorage", "probe")).toBe("kept");
    removeStorageItem("localStorage", "probe");
    expect(readStorageItem("localStorage", "probe")).toBeNull();
  });

  it.each(["localStorage", "sessionStorage"] as const)(
    "never throws when reading %s is denied",
    (name) => {
      denyStorage(name);
      expect(getBrowserStorage(name)).toBeNull();
      expect(readStorageItem(name, "any")).toBeNull();
      expect(writeStorageItem(name, "any", "value")).toBe(false);
      expect(() => removeStorageItem(name, "any")).not.toThrow();
    },
  );

  it("reports a refused write as false rather than throwing", () => {
    Object.defineProperty(window, "localStorage", {
      configurable: true,
      value: {
        ...createMemoryStorage(),
        setItem: () => {
          throw new DOMException("The quota has been exceeded.", "QuotaExceededError");
        },
      },
    });
    expect(writeStorageItem("localStorage", "any", "value")).toBe(false);
  });

  describe("resolveStorageOrMemory", () => {
    it("hands back the real store when it is available", () => {
      expect(resolveStorageOrMemory("localStorage")).toBe(window.localStorage);
    });

    it("hands back one shared working store per name when storage is denied", () => {
      denyStorage("localStorage");
      denyStorage("sessionStorage");

      const local = resolveStorageOrMemory("localStorage");
      const session = resolveStorageOrMemory("sessionStorage");

      expect(local).not.toBe(session);
      expect(resolveStorageOrMemory("localStorage")).toBe(local);

      local.setItem("token", "value");
      expect(local.getItem("token")).toBe("value");
      expect(local.length).toBe(1);
      expect(local.key(0)).toBe("token");
      expect(session.getItem("token")).toBeNull();
      local.removeItem("token");
      expect(local.getItem("token")).toBeNull();
      local.setItem("a", "1");
      local.clear();
      expect(local.length).toBe(0);
    });
  });
});
