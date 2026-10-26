import { expect, it, vi } from "vitest";
import { createAnalyticsDataLayer, type AnalyticsBrowserWindow } from "../../src/marketing/index.js";
function fixture() {
  let stored = JSON.stringify({ necessary: true, functional: false, analytics: true, marketing: false });
  const browser = { localStorage: { getItem: vi.fn(() => stored) },
    addEventListener: vi.fn(), removeEventListener: vi.fn() } as unknown as AnalyticsBrowserWindow;
  const sink = vi.fn(() => true);
  const options = { getWindow: () => browser, consentStorageKey: "choice", consentChangeEvent: "choice-changed",
    eventPrefix: "host_", readContainerId: () => "container:one", trackDeploymentEvent: sink };
  return { browser, sink, options, analytics: createAnalyticsDataLayer(options), store: (value: string) => { stored = value; } };
}
it("admits each sink independently of optional consent", () => {
  const f = fixture(); f.store("{}");
  expect(f.analytics.emitAnalyticsEvent("configurator_start", { entry_view: "hero" })).toEqual({ deployment: true, optional: false });
  expect(f.browser.dataLayer).toBeUndefined(); expect(f.sink).toHaveBeenCalledTimes(1);
});
it("isolates a throwing deployment sink", () => {
  const f = fixture(); f.sink.mockImplementation(() => { throw new Error("sink unavailable"); });
  expect(f.analytics.emitAnalyticsEvent("configurator_start", { entry_view: "hero" })).toEqual({ deployment: false, optional: true });
  expect(f.browser.dataLayer).toHaveLength(3);
});
it("isolates a rejecting optional layer", () => {
  const f = fixture(); f.browser.dataLayer = []; f.browser.dataLayer.push = () => { throw new Error("layer unavailable"); };
  expect(f.analytics.emitAnalyticsEvent("page_view", { page_path: "/" })).toEqual({ deployment: true, optional: false });
});
it("does not replay pre-consent product events when consent is granted", () => {
  const f = fixture(); f.store("{}");
  expect(f.analytics.pushAnalyticsEvent("configurator_start", { entry_view: "hero" })).toBe(false);
  f.store(JSON.stringify({ necessary: true, functional: false, analytics: true, marketing: false }));
  expect(f.analytics.pushAnalyticsEvent("page_view", { page_path: "/" })).toBe(true);
  expect(f.browser.dataLayer?.map(value => (value as { event?: string }).event).filter(Boolean)).toEqual(["host_page_view"]);
});

// New seam 1: fully inert defaults, including server-side consent commands/subscriptions.
it("has inert defaults without a browser", () => {
  const analytics = createAnalyticsDataLayer();
  expect(analytics.readCookieConsent()).toBeNull(); expect(analytics.hasAnalyticsConsent()).toBe(false);
  expect(analytics.configuredContainerId()).toBeNull();
  expect(analytics.emitAnalyticsEvent("page_view", { page_path: "/" })).toEqual({ deployment: false, optional: false });
  expect(() => { analytics.pushAnalyticsConsentDefault(); analytics.pushAnalyticsConsentUpdate(true);
    analytics.subscribeToAnalyticsConsent(() => undefined)(); }).not.toThrow();
});
// New seam 2: injected names, storage, listeners and synchronous attempt mask.
it("uses only injected storage, event, prefix, container reader and sink", () => {
  const f = fixture(); const listener = vi.fn(); const unsubscribe = f.analytics.subscribeToAnalyticsConsent(listener);
  expect(f.browser.addEventListener).toHaveBeenNthCalledWith(1, "storage", expect.any(Function));
  expect(f.browser.addEventListener).toHaveBeenNthCalledWith(2, "choice-changed", listener);
  const onStorage = vi.mocked(f.browser.addEventListener).mock.calls[0][1] as (event: StorageEvent) => void;
  onStorage({ key: "other" } as StorageEvent); expect(listener).not.toHaveBeenCalled();
  onStorage({ key: "choice" } as StorageEvent); expect(listener).toHaveBeenCalledTimes(1);
  unsubscribe(); expect(f.browser.removeEventListener).toHaveBeenCalledTimes(2);
  expect(f.analytics.emitAnalyticsEvent("page_view", { page_path: "/" }, { deployment: false, optional: true }))
    .toEqual({ deployment: false, optional: true });
  expect(f.sink).not.toHaveBeenCalled(); expect(f.browser.localStorage.getItem).toHaveBeenCalledWith("choice");
  expect(f.browser.dataLayer?.[2]).toEqual({ event: "host_page_view", page_path: "/" });
  const unconfigured = createAnalyticsDataLayer({ ...f.options, readContainerId: () => null });
  expect(unconfigured.pushAnalyticsEvent("page_view", { page_path: "/" })).toBe(false);
});
// New seam 3: readiness state and listeners belong to one instance.
it("isolates loader readiness and its listener lifecycle", () => {
  const first = createAnalyticsDataLayer(); const second = createAnalyticsDataLayer(); const listener = vi.fn();
  const unsubscribe = first.subscribeToAnalyticsLoaderReadiness(listener);
  first.markAnalyticsLoaderReady(); first.markAnalyticsLoaderReady();
  expect(first.isAnalyticsLoaderReady()).toBe(true); expect(second.isAnalyticsLoaderReady()).toBe(false);
  expect(listener).toHaveBeenCalledTimes(1); first.resetAnalyticsLoaderReadiness();
  expect(first.isAnalyticsLoaderReady()).toBe(false); unsubscribe(); first.markAnalyticsLoaderReady();
  expect(listener).toHaveBeenCalledTimes(1);
});
// New seam 4: injection preserves parser, command shape, seeding order and push-time advertising consent.
it("preserves strict stored booleans and ordered array-like consent commands", () => {
  const f = fixture();
  for (const raw of ["bad", "null", "[]", "{}", '{"necessary":true,"functional":false,"analytics":true,"marketing":1}']) {
    f.store(raw); expect(f.analytics.readCookieConsent()).toBeNull();
  }
  f.store(JSON.stringify({ necessary: true, functional: false, analytics: true, marketing: true, extra: 1 }));
  f.analytics.pushAnalyticsEvent("page_view", { page_path: "/" });
  const commands = f.browser.dataLayer!;
  expect(Object.prototype.toString.call(commands[0])).toBe("[object Arguments]");
  expect(Array.from(commands[0] as IArguments)).toEqual(["consent", "default", {
    analytics_storage: "denied", ad_storage: "denied", ad_user_data: "denied", ad_personalization: "denied" }]);
  expect(Array.from(commands[1] as IArguments)).toEqual(["consent", "update", {
    analytics_storage: "granted", ad_storage: "granted", ad_user_data: "granted", ad_personalization: "granted" }]);
  f.store(JSON.stringify({ necessary: true, functional: false, analytics: true, marketing: false }));
  f.analytics.pushAnalyticsConsentUpdate(true);
  expect((commands[3] as IArguments)[2]).toEqual({ analytics_storage: "granted", ad_storage: "denied", ad_user_data: "denied", ad_personalization: "denied" });
  f.store(JSON.stringify({ necessary: true, functional: false, analytics: true, marketing: true }));
  f.analytics.pushAnalyticsConsentUpdate(false);
  expect((commands[4] as IArguments)[2]).toEqual({ analytics_storage: "denied", ad_storage: "denied", ad_user_data: "denied", ad_personalization: "denied" });
});
