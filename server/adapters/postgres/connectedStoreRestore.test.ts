import type { Pool } from "pg";
import { expect, it, vi } from "vitest";
import { readPlatformMigrationManifest, type PlatformMigrationManifest } from "../../../scripts/platform-migration-manifest.js";
import { sealConnectedCapture } from "../../../tests/postgres/connectedStoreHistoricalPacket.fixture.js";
import { connectedStoreSourceShape, restoreConnectedNativeStore } from "./connectedStoreRestore.js";

it("routes qualified source inventories and refuses unknown inventories before connecting", async () => {
  const manifest = readPlatformMigrationManifest(process.cwd()) as PlatformMigrationManifest | null;
  if (manifest?.schemaVersion !== 3) throw new Error("Qualified installation inventories required");
  const qualified = manifest.qualified.objectInventorySha256;
  const admin = manifest.qualifiedAdmin.objectInventorySha256;
  const currentInventories = {
    bootstrap: qualified.bootstrapMigrator.withRestore,
    separate: qualified.separateMigrator.withRestore,
    "installer-managed": admin.installerManaged,
    "operator-provisioned": admin.operatorProvisioned,
  };
  const predecessors = [
    { shape: "beforePublicationCommands", inventories: {
      bootstrap: "1c9190ad0520e6ce8229a81ed9ba756da528986d19cad09fc1716d72dadd70c0",
      separate: "c19175002e39e2b4100841e7138759a4dd07fe3158ebd3ce5f7283a5e8d538a9",
      "installer-managed": "10be382792deaf1cb8f7c1620984d3c47a5c7e8b1cb1634aa7e44374370d2c00",
      "operator-provisioned": "9979a84636b80febb605161e2df5fe14b59ad975781b697bd42fee0dcd9dc71c",
    } },
    { shape: "beforeCheckoutAttemptLedger", inventories: {
      bootstrap: "df04bdf1590aae92df0fe1885a90a6f7d8c25075a38b3e57a5a66f9bb358eadb",
      separate: "0fca9c01fd08e76700cd55eaafb81ff1dd9f265ed9a672d3c9936812c8df1153",
      "installer-managed": "955596b9524fa304df1240b3e170d920c1ba27aefc366fb436c78bf7abb326b5",
      "operator-provisioned": "443cb07abc88ad43dd3c712310b31204f242b50793fc40d0a5e5ba8765995017",
    } },
    { shape: "beforeAcceptedReferences", inventories: { // Before governed lifecycle.
      bootstrap: "25bc3a527c27eb205c60b26e388d475bc8532638e66537438e60659a77214f20",
      separate: "b80abf637c8f3f6f854fcac09c88c6b9774857f93c41f0f94664e20f7e62b385",
      "installer-managed": "37df11b3df727367715dcabaff16e366fac0477c8a09167d3f180e31746b82c4",
      "operator-provisioned": "4c05ab3d6ed00157305853bdfd272469feabc03c6528aab3d6eec7a7e7a2d8ac",
    } },
    { shape: "beforeAcceptedReferences", inventories: {
      bootstrap: "ec9028a590334948606d160362e9363c50793284548c2b9c092a71632234724c",
      separate: "1feea98acf1cd7cdf1de399cdf8ab8c9ff6a30cec67168a274428f05f4722638",
      "installer-managed": "02c68db9202830bd08f574130d3a3de19345a4050b8879d3338824b379474195",
      "operator-provisioned": "a05e24a7dcdc6cb4394907be818520a33fa89e9a269a7c01853cd656ecfcf91b",
    } },
    { shape: "current", inventories: {
      bootstrap: "c6fea6b7fe85a7963f952994c34e1dfbca87045952e3dadbbf947c4b89aab5f6",
      separate: "d0a803fd96d5fe048179cff18181c437ede56daa3a8dc14b2ee0a62381753619",
      "installer-managed": "412caa25526d6ba70bb5bb761d5bed2336e7307811a879658295819ad5ab15f5",
      "operator-provisioned": "d413c04713b9fb5f5f9d8f01dc66c68c67d131f6cc94bcbf12becef47abd4f42",
    } },
  ];
  const unknownId = "0".repeat(64);
  for (const profile of ["bootstrap", "separate", "installer-managed", "operator-provisioned"] as const) {
    const current = currentInventories[profile];
    for (const { shape, inventories } of predecessors) {
      const id = inventories[profile];
      expect(connectedStoreSourceShape(profile, id, current), `${profile}: ${id}`).toBe(shape);
    }
    expect(connectedStoreSourceShape(profile, current, current), profile).toBe("current");
    expect(connectedStoreSourceShape(profile, unknownId, current), profile).toBe("unsupported");
  }

  const packet = sealConnectedCapture({
    format: "openlup.native-retained-store.v1",
    compatible: { format: "openlup.compatible-rows.v1", sourceId: "unknown-inventory", catalogueId: unknownId, tables: [], sha256: "" },
    observation: { cluster: "source", database: "store", login: "postgres", snapshot: "1" },
    outsideProfileCensus: [], emptyOutsideProfile: [], owned: [], sha256: "",
  });
  const connect = vi.fn();
  await expect(restoreConnectedNativeStore({
    owner: { connect } as unknown as Pool,
    installation: { generation: "qualified-v2", roleMode: "installer-managed", bootstrapLogin: "postgres", migrationLogin: "postgres",
      runtimeLogin: "store_runtime", restoreLogin: "store_restore" },
    packet,
    freshTarget: packet,
  })).rejects.toMatchObject({ code: "schema_conflict", remedy: "upgrade the source, then capture" });
  expect(connect).not.toHaveBeenCalled();
});
