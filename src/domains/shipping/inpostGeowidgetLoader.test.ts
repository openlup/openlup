// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";

const JS = 'script[src="https://geowidget.inpost.pl/inpost-geowidget.js"]';
const CSS = 'link[href="https://geowidget.inpost.pl/inpost-geowidget.css"]';

afterEach(() => {
  vi.resetModules();
  vi.unstubAllEnvs();
  document.head.innerHTML = "";
});

describe("inpostGeowidgetLoader", () => {
  it("reads and trims the public token from the env", async () => {
    vi.stubEnv("VITE_INPOST_GEOWIDGET_KEY", "  tok-123  ");
    const mod = await import("./inpostGeowidgetLoader");
    expect(mod.inpostGeowidgetToken()).toBe("tok-123");
    expect(mod.inpostGeowidgetConfigured()).toBe(true);
  });

  it("is unconfigured when the token is empty", async () => {
    vi.stubEnv("VITE_INPOST_GEOWIDGET_KEY", "");
    const mod = await import("./inpostGeowidgetLoader");
    expect(mod.inpostGeowidgetConfigured()).toBe(false);
  });

  it("injects the CDN script + stylesheet exactly once", async () => {
    const mod = await import("./inpostGeowidgetLoader");
    void mod.loadInpostGeowidget();
    void mod.loadInpostGeowidget();
    expect(document.querySelectorAll(JS)).toHaveLength(1);
    expect(document.querySelectorAll(CSS)).toHaveLength(1);
    expect(document.querySelector<HTMLScriptElement>(JS)?.defer).toBe(true);
  });

  it("rejects when the CDN script fails to load", async () => {
    const mod = await import("./inpostGeowidgetLoader");
    const pending = mod.loadInpostGeowidget();
    document.querySelector(JS)?.dispatchEvent(new Event("error"));
    await expect(pending).rejects.toThrow(/inpost_geowidget_script_error/);
  });
});
