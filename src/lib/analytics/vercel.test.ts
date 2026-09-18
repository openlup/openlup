import { describe, expect, it, vi, beforeEach } from "vitest";

const pageview = vi.fn();
const track = vi.fn();

vi.mock("@vercel/analytics", () => ({
  pageview: (...args: unknown[]) => pageview(...args),
  track: (...args: unknown[]) => track(...args),
}));

import { createVercelAnalytics } from "./vercel.js";

describe("createVercelAnalytics", () => {
  beforeEach(() => {
    pageview.mockReset();
    track.mockReset();
  });

  it("maps trackPageView onto @vercel/analytics pageview", () => {
    createVercelAnalytics().trackPageView("/koszyk");
    expect(pageview).toHaveBeenCalledWith({ path: "/koszyk" });
  });

  it("maps trackEvent onto track, forwarding only scalar properties", () => {
    createVercelAnalytics().trackEvent("Purchase", {
      value: 99,
      currency: "PLN",
      paid: true,
      empty: null,
      nested: { a: 1 },
      arr: [1, 2],
    });
    expect(track).toHaveBeenCalledWith("Purchase", {
      value: 99,
      currency: "PLN",
      paid: true,
      empty: null,
    });
  });

  it("passes undefined when no properties are given", () => {
    createVercelAnalytics().trackEvent("Click");
    expect(track).toHaveBeenCalledWith("Click", undefined);
  });
});
