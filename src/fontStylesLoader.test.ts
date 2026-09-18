// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const fontHref = "https://fonts.example.test/family.css";
let initialHeadHtml = "";

function addFontStylesheetPreload() {
  const preload = document.createElement("link");
  preload.rel = "preload";
  preload.as = "style";
  preload.href = fontHref;
  preload.dataset.fontStylesheet = "";
  document.head.append(preload);
  return preload;
}

function addAppStylesheetPreload() {
  const preload = document.createElement("link");
  preload.rel = "preload";
  preload.as = "style";
  preload.href = "/assets/index.css";
  preload.dataset.appStylesheet = "";
  document.head.append(preload);
  return preload;
}

describe("fontStylesLoader", () => {
  beforeEach(() => {
    vi.resetModules();
    initialHeadHtml = document.head.innerHTML;
    document.head.innerHTML = "";
  });

  afterEach(() => {
    document.head.innerHTML = initialHeadHtml;
    vi.restoreAllMocks();
  });

  it("activates an already completed stylesheet preload", async () => {
    const preload = addFontStylesheetPreload();
    vi.spyOn(performance, "getEntriesByName").mockReturnValue([{} as PerformanceEntry]);

    await import("@/fontStylesLoader");

    expect(preload.rel).toBe("stylesheet");
    expect(preload.hasAttribute("as")).toBe(false);
    expect(preload.dataset.fontStylesheet).toBeUndefined();
  });

  it("activates a pending preload after its load event", async () => {
    const preload = addFontStylesheetPreload();
    vi.spyOn(performance, "getEntriesByName").mockReturnValue([]);

    await import("@/fontStylesLoader");
    expect(preload.rel).toBe("preload");

    preload.dispatchEvent(new Event("load"));

    expect(preload.rel).toBe("stylesheet");
    expect(preload.hasAttribute("as")).toBe(false);
  });

  it("activates the deferred full app stylesheet through the same external loader", async () => {
    const preload = addAppStylesheetPreload();
    vi.spyOn(performance, "getEntriesByName").mockReturnValue([]);

    await import("@/fontStylesLoader");
    expect(preload.rel).toBe("preload");

    preload.dispatchEvent(new Event("load"));

    expect(preload.rel).toBe("stylesheet");
    expect(preload.hasAttribute("as")).toBe(false);
    expect(preload.dataset.appStylesheet).toBeUndefined();
  });
});
