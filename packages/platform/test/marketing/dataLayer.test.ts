import { expect, it, vi } from "vitest";
import { createAnalyticsDataLayer, type AnalyticsBrowserWindow } from "../../src/marketing/index.js";
function fixture(consentSignalNames = { analytics: "measurement", advertising: ["campaign", "attribution", "personalization"] }) {
  let stored = JSON.stringify({ necessary: true, functional: false, analytics: true, marketing: false });
  const browser = { localStorage: { getItem: vi.fn(() => stored) },
    addEventListener: vi.fn(), removeEventListener: vi.fn() } as unknown as AnalyticsBrowserWindow;
  const sink = vi.fn(() => true);
  const options = { getWindow: () => browser, consentStorageKey: "choice", consentChangeEvent: "choice-changed",
    consentSignalNames, eventPrefix: "host_", readContainerId: () => "container:one", trackDeploymentEvent: sink };
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
  const f = fixture();
  const withoutSignals = createAnalyticsDataLayer({ ...f.options, consentSignalNames: undefined });
  expect(withoutSignals.pushAnalyticsEvent("page_view", { page_path: "/" })).toBe(false);
  expect(f.browser.dataLayer).toBeUndefined();
  f.browser.dataLayer = [];
  withoutSignals.pushAnalyticsConsentDefault(); withoutSignals.pushAnalyticsConsentUpdate(true);
  expect(withoutSignals.emitAnalyticsEvent("page_view", { page_path: "/" })).toEqual({ deployment: true, optional: false });
  expect(f.browser.dataLayer).toEqual([]); expect(f.sink).toHaveBeenCalledTimes(1);
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
  const signalKeys = ["measurement", "campaign", "attribution", "personalization"];
  const defaultSettings = (f.browser.dataLayer![0] as IArguments)[2];
  const updateSettings = (f.browser.dataLayer![1] as IArguments)[2];
  expect(Object.keys(defaultSettings)).toEqual(signalKeys);
  expect(Object.keys(updateSettings)).toEqual(signalKeys);
  expect(defaultSettings).toEqual({ measurement: "denied", campaign: "denied", attribution: "denied", personalization: "denied" });
  expect(updateSettings).toEqual({ measurement: "granted", campaign: "denied", attribution: "denied", personalization: "denied" });
  f.store(JSON.stringify({ necessary: true, functional: false, analytics: true, marketing: true }));
  f.analytics.pushAnalyticsConsentUpdate(true);
  expect((f.browser.dataLayer![3] as IArguments)[2]).toEqual({ measurement: "granted", campaign: "granted", attribution: "granted", personalization: "granted" });
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
it("preserves reference-compatible stored booleans and ordered array-like consent commands", () => {
  const f = fixture({ analytics: "measurement", advertising: ["advertising_storage", "advertising_user_data", "advertising_personalization"] });
  for (const raw of ["bad", "null", "[]", "{}", '{"necessary":true,"functional":false,"analytics":true,"marketing":1}']) {
    f.store(raw); expect(f.analytics.readCookieConsent()).toBeNull();
  }
  f.store(JSON.stringify({ necessary: true, functional: false, analytics: true, marketing: true, extra: 1 }));
  f.analytics.pushAnalyticsEvent("page_view", { page_path: "/" });
  const commands = f.browser.dataLayer!;
  expect(Object.prototype.toString.call(commands[0])).toBe("[object Arguments]");
  expect(Array.from(commands[0] as IArguments)).toEqual(["consent", "default", {
    measurement: "denied", advertising_storage: "denied", advertising_user_data: "denied", advertising_personalization: "denied" }]);
  expect(Array.from(commands[1] as IArguments)).toEqual(["consent", "update", {
    measurement: "granted", advertising_storage: "granted", advertising_user_data: "granted", advertising_personalization: "granted" }]);
  expect(JSON.stringify((commands[0] as IArguments)[2])).toBe('{"measurement":"denied","advertising_storage":"denied","advertising_user_data":"denied","advertising_personalization":"denied"}');
  expect(JSON.stringify((commands[1] as IArguments)[2])).toBe('{"measurement":"granted","advertising_storage":"granted","advertising_user_data":"granted","advertising_personalization":"granted"}');
  f.store(JSON.stringify({ necessary: true, functional: false, analytics: true, marketing: false }));
  f.analytics.pushAnalyticsConsentUpdate(true);
  expect((commands[3] as IArguments)[2]).toEqual({ measurement: "granted", advertising_storage: "denied", advertising_user_data: "denied", advertising_personalization: "denied" });
  f.store(JSON.stringify({ necessary: true, functional: false, analytics: true, marketing: true }));
  f.analytics.pushAnalyticsConsentUpdate(false);
  expect((commands[4] as IArguments)[2]).toEqual({ measurement: "denied", advertising_storage: "denied", advertising_user_data: "denied", advertising_personalization: "denied" });
});

// Opt-in hosts can admit advertising without granting analytics.
it.each([[false,false],[true,false],[false,true],[true,true]])("keeps independent consent for analytics=%s marketing=%s", (analytics, marketing) => {
  const f=fixture();
  f.store(JSON.stringify({necessary:true,functional:false,analytics,marketing}));
  const layer=createAnalyticsDataLayer({...f.options,consentPolicy:"independent"});
  expect(layer.pushAnalyticsEvent("page_view",{page_path:"/"})).toBe(analytics || marketing);
  if (!analytics && !marketing) { expect(f.browser.dataLayer).toBeUndefined(); return; }
  expect((f.browser.dataLayer![1] as IArguments)[2]).toEqual({measurement:analytics?"granted":"denied",campaign:marketing?"granted":"denied",attribution:marketing?"granted":"denied",personalization:marketing?"granted":"denied"});
  layer.pushAnalyticsConsentUpdate(false);
  expect((f.browser.dataLayer!.at(-1) as IArguments)[2]).toEqual({measurement:"denied",campaign:"denied",attribution:"denied",personalization:"denied"});
  f.store(JSON.stringify({necessary:true,functional:false,analytics:false,marketing:false}));
  expect(layer.pushAnalyticsEvent("page_view",{page_path:"/later"})).toBe(false);
});
it("retains the analytics requirement by default and refuses malformed opt-in consent",()=>{
  const f=fixture();f.store(JSON.stringify({necessary:true,functional:false,analytics:false,marketing:true}));
  expect(f.analytics.pushAnalyticsEvent("page_view",{page_path:"/"})).toBe(false);
  const layer=createAnalyticsDataLayer({...f.options,consentPolicy:"independent"});
  for(const raw of ['{}','null','{"marketing":true}','{"necessary":true,"functional":false,"analytics":false,"marketing":"true"}']){
    f.store(raw);expect(layer.pushAnalyticsEvent("page_view",{page_path:"/"})).toBe(false);
  }
});


it.each([[false,false],[true,false],[false,true],[true,true]])("admits consent-aware observations without inventing grants for analytics=%s marketing=%s", (analytics,marketing)=>{
  const f=fixture();f.store(JSON.stringify({necessary:true,functional:false,analytics,marketing}));
  const layer=createAnalyticsDataLayer({...f.options,consentPolicy:"host-authorized"});
  expect(layer.pushAnalyticsEvent("page_view",{page_path:"/"})).toBe(true);
  expect(Array.from(f.browser.dataLayer![0] as IArguments)).toEqual(["consent","default",{measurement:"denied",campaign:"denied",attribution:"denied",personalization:"denied"}]);
  expect((f.browser.dataLayer![1] as IArguments)[2]).toEqual({measurement:analytics?"granted":"denied",campaign:marketing?"granted":"denied",attribution:marketing?"granted":"denied",personalization:marketing?"granted":"denied"});
  f.store(JSON.stringify({necessary:true,functional:false,analytics:false,marketing:false}));
  layer.pushAnalyticsConsentUpdate(true);
  expect((f.browser.dataLayer!.at(-1) as IArguments)[2]).toEqual({measurement:"denied",campaign:"denied",attribution:"denied",personalization:"denied"});
  expect(layer.pushAnalyticsEvent("page_view",{page_path:"/later"})).toBe(true);
  layer.pushAnalyticsConsentUpdate(false);
  expect((f.browser.dataLayer!.at(-1) as IArguments)[2]).toEqual({measurement:"denied",campaign:"denied",attribution:"denied",personalization:"denied"});
});
it.each(["bad","null","{}",'{"necessary":true,"functional":false,"analytics":"true","marketing":true}'])("consent-aware admission treats malformed choice as denial: %s",raw=>{
  const f=fixture();f.store(raw);
  const layer=createAnalyticsDataLayer({...f.options,consentPolicy:"host-authorized"});
  expect(layer.pushAnalyticsEvent("page_view",{page_path:"/"})).toBe(true);
  expect((f.browser.dataLayer![1] as IArguments)[2]).toEqual({measurement:"denied",campaign:"denied",attribution:"denied",personalization:"denied"});
});
it("keeps absent signal/container/browser refusal for consent-aware hosts",()=>{
  const f=fixture();
  for(const override of [{consentSignalNames:undefined},{readContainerId:()=>null},{getWindow:()=>undefined}]){
    const layer=createAnalyticsDataLayer({...f.options,consentPolicy:"host-authorized",...override});
    expect(layer.pushAnalyticsEvent("page_view",{page_path:"/"})).toBe(false);
  }
  expect(f.browser.dataLayer).toBeUndefined();
});


it.each(["analytics-only","independent","host-authorized"] as const)("preserves caller-update compatibility only in the default policy: %s",consentPolicy=>{
  const f=fixture();f.store(JSON.stringify({necessary:true,functional:false,analytics:false,marketing:true}));f.browser.dataLayer=[];
  const layer=createAnalyticsDataLayer({...f.options,consentPolicy});layer.pushAnalyticsConsentUpdate(true);
  expect((f.browser.dataLayer![0] as IArguments)[2]).toEqual({measurement:consentPolicy==="analytics-only"?"granted":"denied",campaign:"granted",attribution:"granted",personalization:"granted"});
  layer.pushAnalyticsConsentUpdate(false);
  expect((f.browser.dataLayer![1] as IArguments)[2]).toEqual({measurement:"denied",campaign:"denied",attribution:"denied",personalization:"denied"});
});
