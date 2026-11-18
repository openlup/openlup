import { describe, expect, it, vi } from "vitest";
import { createCatalogRuntimeBinding, type CatalogRuntimeObservation } from "../../src/catalog/catalogRuntimeBinding.js";
import { createPostgresCatalogAdoption } from "../../src/catalog/catalogAdoption.js";
import type { CatalogPublicationDependencies } from "../../src/catalog/publicationPortsV2.js";

const lanes = ["publicationRead", "publish", "lifecycleWrite", "shopper", "settlement", "account", "editor", "renewal", "successor"] as const;
const qualified = async (): Promise<CatalogRuntimeObservation> => ({ schemaCompatible: true, privilegeGranted: true, state: "ready" });
const observations = [
  ["LC8-N-001 enabled", true, true, true, "ready", "ready"],
  ["LC8-N-001 absent host opt-in", false, true, true, "ready", "unsupported"],
  ["LC8-N-001 absent schema", true, false, true, "ready", "unsupported"],
  ["LC8-N-001 absent grant", true, true, false, "ready", "unsupported"],
  ["LC8-D-017 existing unadopted scope", true, true, true, "unadopted", "unadopted"],
  ["LC8-D-017 bound scope outage", true, false, false, "dependency_unavailable", "dependency_unavailable"],
] as const;
describe.each(lanes)("catalog_capabilities_and_writer_disable %s", lane => {
  it.each(observations)("%s", async (_rule, enabled, schemaCompatible, privilegeGranted, observed, expected) => {
    const usePort = vi.fn(async () => []);
    const binding = createCatalogRuntimeBinding({ writerEnabled: () => true,
      ports: { [lane]: { port: { read: usePort }, enabled: () => enabled, observe: async () => ({ schemaCompatible, privilegeGranted, state: observed }) } } });
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
  const lane = { port: vi.fn(async () => "retained"), enabled: () => true, observe: qualified };
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
    shopper: { port: { read }, enabled: () => true, observe: qualified },
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
    publicationRead: { port: alternate, enabled: () => true, observe: qualified },
  } });
  expect(await binding.use("shopper", port => port())).toMatchObject({ outcome: "unsupported" });
  expect(alternate).not.toHaveBeenCalled();
});

it.each([
  ["guest", { ok: false }],
  ["non-admin", { ok: true, role: "support", isMachineActor: false }],
  ["machine", { ok: true, role: "admin", isMachineActor: true }],
  ["missing machine claim", { ok: true, role: "admin" }],
])("catalog_bound_actor_lanes LC8-D-004 denies %s", async (_rule, input) => {
  const productId = "c2bfd5ba-846b-4348-82c7-6781ea6323ca";
  const transaction = vi.fn();
  const authorization = { ...input, userId: productId } as Awaited<ReturnType<CatalogPublicationDependencies<null>["authorizeHuman"]>>;
  const port = createPostgresCatalogAdoption({ authorizeHuman: async () => authorization, transaction });
  expect(await port.adopt({ productId, commandKey: "verified", sourceDigest: "a".repeat(64) }, null)).toEqual({
    outcome: "unauthorized", reason: "publisher_not_authorized",
  });
  expect(transaction).not.toHaveBeenCalled();
});
