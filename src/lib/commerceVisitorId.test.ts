/** @vitest-environment jsdom */
import { afterEach, describe, expect, it } from "vitest";

import {
  getOrCreateVisitorId,
  resetSessionVisitorIdForTests,
  VISITOR_ID_KEY,
} from "./commerceVisitorId";

const restore: Array<() => void> = [];

afterEach(() => {
  while (restore.length > 0) restore.pop()!();
  window.localStorage.clear();
  window.sessionStorage.clear();
  resetSessionVisitorIdForTests();
});

function denyStorage(kind: "localStorage" | "sessionStorage"): void {
  const original = Object.getOwnPropertyDescriptor(window, kind)
    ?? Object.getOwnPropertyDescriptor(Object.getPrototypeOf(window), kind);
  Object.defineProperty(window, kind, {
    configurable: true,
    get() {
      throw new Error(`${kind} is denied`);
    },
  });
  restore.push(() => {
    if (original) Object.defineProperty(window, kind, original);
  });
}

describe("commerce visitor id", () => {
  it("persists and reuses one id while localStorage is available", () => {
    const first = getOrCreateVisitorId();
    expect(first).toEqual(expect.any(String));
    expect(window.localStorage.getItem(VISITOR_ID_KEY)).toBe(first);
    expect(getOrCreateVisitorId()).toBe(first);
  });

  it("falls back to sessionStorage when localStorage is denied", () => {
    denyStorage("localStorage");

    const id = getOrCreateVisitorId();
    expect(id).toEqual(expect.any(String));
    expect(window.sessionStorage.getItem(VISITOR_ID_KEY)).toBe(id);
    expect(getOrCreateVisitorId()).toBe(id);
  });

  // Regression: an undefined id makes the server refuse to assign an offer
  // policy at all, so a storage-denied browser (private window, embedded
  // webview, blocked site data) got no price and no checkout.
  it("still yields one stable id for the page session when every store is denied", () => {
    denyStorage("localStorage");
    denyStorage("sessionStorage");

    const id = getOrCreateVisitorId();
    expect(id).toEqual(expect.any(String));
    expect(id).not.toBe("");
    expect(getOrCreateVisitorId()).toBe(id);
  });

  it("adopts an id already persisted by an earlier visit", () => {
    window.localStorage.setItem(VISITOR_ID_KEY, "existing-visitor-id");
    expect(getOrCreateVisitorId()).toBe("existing-visitor-id");
  });
});
