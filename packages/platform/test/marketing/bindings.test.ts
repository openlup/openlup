import { expect, it, vi } from "vitest";
import { createMarketingPrivacyBindings, type MarketingAcquisitionPrivacyPort, type MarketingRemoteErasurePort } from "../../src/marketing/server/index.js";
import { createMarketingContribution } from "../../src/composition/index.js";
const acquisition: MarketingAcquisitionPrivacyPort<null> = { export: vi.fn(), assessErasure: vi.fn(), eraseOrRetain: vi.fn() };
const remoteErasure: MarketingRemoteErasurePort<null> = { read: vi.fn(), openAndFence: vi.fn() };
const randomId = vi.fn(() => "00000000-0000-4000-8000-000000000001");
it("defaults off and reports one readiness issue per unbound or incomplete owner", () => {
  const disabled = createMarketingPrivacyBindings({ acquisition, remoteErasure, randomId });
  expect(disabled.contributor).toBeNull(); expect(Object.values(disabled.callables)).toEqual([null, null, null]);
  expect(createMarketingPrivacyBindings({ enabled: false, acquisition, remoteErasure, randomId }).contributor).toBeNull();
  const absent = createMarketingPrivacyBindings({ enabled: true, acquisition: null, remoteErasure: null, randomId });
  expect(absent.contributor).toBeNull();
  expect(absent.issues).toEqual(["acquisition", "remoteErasure"].map(subject => expect.objectContaining({ code: "OPENLUP_E_PORT_MISSING", package: "@openlup/platform", module: "marketing", subject })));
  const partial = createMarketingPrivacyBindings({ enabled: true, acquisition, remoteErasure: null, randomId });
  expect(partial.contributor).toBeNull(); expect(partial.issues).toHaveLength(1); expect(Object.values(partial.callables)).toEqual([null, null, null]);
  const incomplete = createMarketingPrivacyBindings({ enabled: true, acquisition: {} as MarketingAcquisitionPrivacyPort<null>, remoteErasure, randomId });
  expect(incomplete.contributor).toBeNull(); expect(incomplete.issues[0]?.subject).toBe("acquisition");
  const contribution = createMarketingContribution({ version: "0.1.0", requiredSchema: { version: "complete", migration: "host", objects: [] },
    marketing: partial.callables, handlers: [], schedules: [], routes: [] });
  expect(contribution.ports).toEqual({});
  expect(contribution.contributions[0].manifest.requiredPorts).toEqual(["exportPersonalData", "assessErasure", "eraseOrRetain"]);
});
it("selects only with both complete owners and shares the single contributor's callables", () => {
  const bindings = createMarketingPrivacyBindings({ enabled: true, acquisition, remoteErasure, randomId });
  expect(bindings.issues).toEqual([]); expect(bindings.contributor?.id).toBe("marketing");
  expect(bindings.callables.exportPersonalData).toBe(bindings.contributor?.export);
  expect(bindings.callables.assessErasure).toBe(bindings.contributor?.assessErasure);
  expect(bindings.callables.eraseOrRetain).toBe(bindings.contributor?.eraseOrRetain);
  const contribution = createMarketingContribution({ version: "0.1.0", requiredSchema: { version: "complete", migration: "host", objects: [] },
    marketing: bindings.callables, handlers: [], schedules: [], routes: [] });
  expect(contribution.ports).toEqual(Object.fromEntries(Object.entries(bindings.callables).map(([name, fn]) => [`@openlup/platform/marketing:${name}`, fn])));
  for (const fn of [...Object.values(acquisition), ...Object.values(remoteErasure), randomId]) expect(fn).not.toHaveBeenCalled();
});
