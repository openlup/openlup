import { expect, it } from "vitest";
import { createReferenceCommunications, admitReferenceCommunications } from "./referenceComposition.js";
const candidate = { artifact: "synthetic", configuration: "selected", environment: "disposable", database: "synthetic", schema: "70" };
const observe = { loadedPackages: [{ name: "@openlup/core", version: "0.16.0", kind: "kernel" as const }, { name: "@openlup/platform", version: "0.16.0", kind: "rail" as const }], inventoryComplete: true };
it("admits actual callable identities and refuses a changed candidate before HTTP or clock work", async () => {
  let effects = 0, current = candidate;
  const route = { id: "/api/synthetic", handle: async () => { effects++; } };
  const run = async () => { effects++; };
  const runtime = createReferenceCommunications({ bundle: "node-postgres", migrationIdentity: "70", routes: [route], schedules: [{ id: "synthetic", cadenceSeconds: 60, run }], ports: { delivery: run } });
  const admitted = await admitReferenceCommunications({ runtime, candidate, currentIdentity: () => current, observed: observe, schemaProbe: { observe: async requirement => ({ database: "synthetic", version: "70", objects: requirement.objects.map(object => ({ object, present: true })) }) } });
  expect(admitted.admitted).toBe(true);
  await admitted.route(route.id, {} as never, {} as never); expect(effects).toBe(1);
  await admitted.run("synthetic"); expect(effects).toBe(2);
  current = { ...candidate, configuration: "changed" };
  await expect(admitted.route(route.id, {} as never, {} as never)).rejects.toThrow("stale");
  await expect(admitted.run("synthetic")).rejects.toThrow("stale"); expect(effects).toBe(2);
});
it("refuses missing port/schema and independent module admissions", async () => {
  const runtime = createReferenceCommunications({ bundle: "node-postgres", migrationIdentity: "70", routes: [], schedules: [], ports: { delivery: null } });
  const result = await admitReferenceCommunications({ runtime, candidate, currentIdentity: () => candidate, observed: observe, schemaProbe: { observe: async requirement => ({ database: "synthetic", version: "69", objects: requirement.objects.map(object => ({ object, present: false })) }) } });
  expect(result.admitted).toBe(false);
  await expect(result.run("unbound")).rejects.toThrow();
});
