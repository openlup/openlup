/** @vitest-environment jsdom -- exercises browser-path behavior (window/storage/DOM). */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createGtmAnalytics } from "./gtm.js";

type DataLayerEvent = { event?: string; [key: string]: unknown };

describe("createGtmAnalytics", () => {
  let original: unknown;

  beforeEach(() => {
    original = (window as unknown as { dataLayer?: unknown }).dataLayer;
    delete (window as unknown as { dataLayer?: unknown }).dataLayer;
  });

  afterEach(() => {
    if (original === undefined) delete (window as unknown as { dataLayer?: unknown }).dataLayer;
    else (window as unknown as { dataLayer?: unknown }).dataLayer = original;
  });

  function dataLayer(): DataLayerEvent[] {
    return (window as unknown as { dataLayer?: DataLayerEvent[] }).dataLayer ?? [];
  }

  it("pushes a page_view event with the path onto the dataLayer", () => {
    createGtmAnalytics().trackPageView("/produkty");
    expect(dataLayer()).toContainEqual({ event: "page_view", page_path: "/produkty" });
  });

  it("pushes a custom event with merged properties", () => {
    createGtmAnalytics().trackEvent("add_to_cart", { value: 42, sku: "abc" });
    expect(dataLayer()).toContainEqual({ event: "add_to_cart", value: 42, sku: "abc" });
  });

  it("initializes the dataLayer when absent", () => {
    expect((window as unknown as { dataLayer?: unknown }).dataLayer).toBeUndefined();
    createGtmAnalytics().trackEvent("ping");
    expect(Array.isArray(dataLayer())).toBe(true);
  });
});