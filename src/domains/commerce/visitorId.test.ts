// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from "vitest";

import { resetSessionVisitorIdForTests } from "@/lib/commerceVisitorId";

import { getOrCreateVisitorId } from "./visitorId";

afterEach(() => {
  vi.restoreAllMocks();
  window.localStorage.clear();
  window.sessionStorage.clear();
  resetSessionVisitorIdForTests();
});

describe("commerce visitor id", () => {
  // This used to pin `undefined`, which the server reads as "no assignment key"
  // and refuses while v1 fallback is disabled — no price for a buyer whose
  // browser denies the store. The compatibility surface must therefore keep
  // yielding one stable id even when the localStorage getter itself throws.
  it("still yields one stable id when the localStorage getter throws", () => {
    vi.spyOn(window, "localStorage", "get").mockImplementation(() => {
      throw new DOMException("Storage disabled", "SecurityError");
    });

    const id = getOrCreateVisitorId();
    expect(id).toEqual(expect.any(String));
    expect(id).not.toBe("");
    expect(getOrCreateVisitorId()).toBe(id);
  });
});
