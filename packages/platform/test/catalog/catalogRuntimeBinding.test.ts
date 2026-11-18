import { describe, expect, it, vi } from "vitest";
import { createCatalogRuntimeBinding } from "../../src/catalog/catalogRuntimeBinding.js";

const lanes = ["publicationRead", "publish", "lifecycleWrite", "shopper", "settlement", "account", "editor", "renewal", "successor"] as const;
const observations = [
  ["LC8-N-001 enabled", true, "ready", "ready"],
  ["LC8-N-001 absent host opt-in", false, "ready", "unsupported"],
  ["LC8-N-001 absent implementation/schema/grant", true, "unsupported", "unsupported"],
  ["LC8-D-017 existing unadopted scope", true, "unadopted", "unadopted"],
  ["LC8-D-017 bound scope outage", true, "dependency_unavailable", "dependency_unavailable"],
] as const;
describe.each(lanes)("catalog_capabilities_and_writer_disable %s", lane => {
  it.each(observations)("%s", async (_rule, enabled, observed, expected) => {
    const usePort = vi.fn(async () => []);
    const binding = createCatalogRuntimeBinding({ writerEnabled: () => true,
      ports: { [lane]: { port: { read: usePort }, enabled: () => enabled, observe: async () => observed } } });
    expect(await binding.observe(lane)).toBe(expected);
    expect(await binding.use(lane, async port => port.read())).toMatchObject({ outcome: expected });
    expect(usePort).toHaveBeenCalledTimes(expected === "ready" ? 1 : 0);
  });
});

it("catalog_capabilities_remain_false_when_unbound LC8-D-001 LC8-N-001", async () => {
  expect(await createCatalogRuntimeBinding().capabilities()).toEqual({
    read: false, draft: false, publicationRead: false, publish: false, lifecycleWrite: false,
  });
});

it("catalog_writer_disable_preserves_new_identity_servicing LC8-N-001 LC8-N-004 LC8-N-005", async () => {
  let write = true;
  const lane = { port: vi.fn(async () => "retained"), enabled: () => true, observe: async () => "ready" as const };
  const binding = createCatalogRuntimeBinding({ writerEnabled: () => write, ports: {
    publish: lane, lifecycleWrite: lane, publicationRead: lane, renewal: lane, account: lane,
  } });
  expect(await binding.capabilities()).toMatchObject({ publish: true, lifecycleWrite: true, publicationRead: true });
  write = false;
  expect(await binding.capabilities()).toMatchObject({ publish: false, lifecycleWrite: false, publicationRead: true });
  expect(await binding.use("publish", run => run())).toMatchObject({ outcome: "unsupported" });
  expect(await binding.use("account", run => run())).toEqual({ outcome: "ready", value: "retained" });
  expect(await binding.use("renewal", run => run())).toEqual({ outcome: "ready", value: "retained" });
  expect(lane.port).toHaveBeenCalledTimes(2);
});

it.each([false, true])("catalog_capabilities_and_writer_disable LC8-D-026 quote batch failure=%s", async fails => {
  const read = vi.fn(async () => {
    if (fails) throw new Error("Authority is down");
    return ["version 1"];
  });
  const binding = createCatalogRuntimeBinding({ ports: {
    shopper: { port: { read }, enabled: () => true, observe: async () => "ready" },
  } });
  const batch = binding.quoteBatch(port => port.read());
  const before = await batch();
  read.mockResolvedValue(["version 2"]);
  expect(await batch()).toBe(before);
  expect(before).toEqual(fails ? { outcome: "dependency_unavailable", reason: "dependency_unavailable" } : { outcome: "ready", value: ["version 1"] });
  expect(read).toHaveBeenCalledTimes(1);
});

it("catalog_capabilities_and_writer_disable LC8-D-001 never selects an available alternate authority", async () => {
  const alternate = vi.fn(async () => []);
  const binding = createCatalogRuntimeBinding<{ shopper: typeof alternate; publicationRead: typeof alternate }>({ ports: {
    publicationRead: { port: alternate, enabled: () => true, observe: async () => "ready" },
  } });
  expect(await binding.use("shopper", port => port())).toMatchObject({ outcome: "unsupported" });
  expect(alternate).not.toHaveBeenCalled();
});
