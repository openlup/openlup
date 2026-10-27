import { afterEach, expect, it, vi } from "vitest";
import { cleanup } from "@testing-library/react";
import { buildHeadDescriptor } from "@openlup/platform/marketing";
import { renderWithProviders } from "../test/render";
import { SeoHead } from "./seoHead";

const facts = {
  origin: "https://shop.example", route: { id: "help", locale: "alpha", canonicalPath: "/help" },
  routes: [], xDefaultLocale: "alpha", htmlLang: "alpha", title: "Example help",
  description: "Example description", siteName: "Example Store", ogImage: "https://shop.example/social.png",
  ogImageWidth: 1200, ogImageHeight: 630, ogLocale: "alpha",
  twitterImage: "https://shop.example/card.png", twitterHandle: "@example", noindex: true,
};

const originalHead = document.head.innerHTML;
const originalLang = document.documentElement.getAttribute("lang");

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  document.head.innerHTML = originalHead;
  document.documentElement.removeAttribute("data-rh");
  if (originalLang === null) document.documentElement.removeAttribute("lang");
  else document.documentElement.setAttribute("lang", originalLang);
});

it("commits the head in a hidden document without an animation frame", () => {
  vi.spyOn(document, "visibilityState", "get").mockReturnValue("hidden");
  vi.spyOn(document, "hidden", "get").mockReturnValue(true);
  const requestFrame = vi.fn(() => 1);
  vi.stubGlobal("requestAnimationFrame", requestFrame);
  renderWithProviders(<SeoHead descriptor={buildHeadDescriptor(facts)} renderMode="csr" />);
  expect(document.hidden).toBe(true);
  expect(document.title).toBe(facts.title);
  expect(document.documentElement.lang).toBe(facts.htmlLang);
  expect(document.head.querySelector('meta[name="description"]')).toHaveAttribute("content", facts.description);
  expect(document.head.querySelector('link[rel="canonical"]')).toHaveAttribute("href", "https://shop.example/help");
  expect(document.head.querySelector('meta[name="robots"]')).toHaveAttribute("content", "noindex, nofollow");
  expect(document.head.querySelector('meta[property="og:image:width"]')).toHaveAttribute("content", "1200");
  expect(document.head.querySelector('meta[property="og:image:height"]')).toHaveAttribute("content", "630");
  expect(document.head.querySelector('meta[name="twitter:site"]')).toHaveAttribute("content", facts.twitterHandle);
  expect(requestFrame).not.toHaveBeenCalled();
});

it("renders hostile JSON-LD unchanged with no injected element and the original parsed value", () => {
  const value = { name: '</script><script id="injected">probe</script>\u2028\u2029' };
  const descriptor = buildHeadDescriptor({ ...facts, jsonLd: value });
  renderWithProviders(<SeoHead descriptor={descriptor} renderMode="csr" />);
  const script = document.head.querySelector('script[type="application/ld+json"]');
  expect(script).not.toBeNull();
  expect(script!.textContent).toBe(descriptor.jsonLd);
  expect(script!.textContent).not.toMatch(/[<\u2028\u2029]/);
  expect(JSON.parse(script!.textContent!)).toEqual({ "@context": "https://schema.org", "@graph": [value] });
  expect(document.querySelector("#injected")).toBeNull();
  expect(document.head.querySelectorAll("script")).toHaveLength(1);
});

it("keeps exactly one canonical and only managed alternates when the shell carries copies", () => {
  document.head.innerHTML = '<link rel="canonical" href="https://shop.example/help"><link rel="alternate" hreflang="beta" href="https://shop.example/other">';
  const route = { ...facts.route, alternateRouteId: "other" };
  const alternate = { id: "other", locale: "beta", canonicalPath: "/other" };
  renderWithProviders(<SeoHead descriptor={buildHeadDescriptor({ ...facts, route, routes: [route, alternate] })} renderMode="csr" />);
  const canonical = document.head.querySelectorAll('link[rel="canonical"]');
  expect(canonical).toHaveLength(1);
  expect(canonical[0]).toHaveAttribute("data-rh");
  expect(canonical[0]).toHaveAttribute("href", "https://shop.example/help");
  const alternates = document.head.querySelectorAll('link[rel="alternate"]');
  expect(alternates).toHaveLength(3);
  for (const link of alternates) expect(link).toHaveAttribute("data-rh");

  cleanup();
  document.head.innerHTML = '<link rel="alternate" hreflang="beta" href="https://shop.example/shell-only">';
  renderWithProviders(<SeoHead descriptor={buildHeadDescriptor(facts)} renderMode="ssg" />);
  expect(document.head.querySelector('link[rel="alternate"]:not([data-rh])'))
    .toHaveAttribute("href", "https://shop.example/shell-only");
});

it("replaces a contradicting shell canonical with the descriptor canonical", () => {
  document.head.innerHTML = '<link rel="canonical" href="https://shop.example/">';
  renderWithProviders(<SeoHead descriptor={buildHeadDescriptor(facts)} renderMode="csr" />);
  const canonical = document.head.querySelectorAll('link[rel="canonical"]');
  expect(canonical).toHaveLength(1);
  expect(canonical[0]).toHaveAttribute("href", "https://shop.example/help");
  expect(canonical[0]).toHaveAttribute("data-rh");
});
