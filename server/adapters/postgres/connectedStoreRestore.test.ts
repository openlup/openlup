import { createHash } from "node:crypto";
import type { Pool } from "pg";
import { expect, it, vi } from "vitest";
import { readPlatformMigrationManifest, type PlatformMigrationManifest } from "../../../scripts/platform-migration-manifest.js";
import { connectedNativeStoreTables, type ConnectedNativeStoreCapture } from "./connectedStoreCapture.js";
import { connectedStoreSourceShape, restoreConnectedNativeStore } from "./connectedStoreRestore.js";
import type { QualifiedAdminPostgresInstallation, QualifiedPostgresInstallation } from "./qualifiedInstall.js";

// From openlup-platform-v1.3.0:tests/postgres/current-installation-inventory.json.
const released = {
  bootstrap: "b0e5b3ac447383aec5cd6185f9b24b0d669a1416a40ef9313490c16a5716d158",
  separate: "251787e365f84f52f45692256850352af5b104baeef10395fd3a8b74949613d6",
  "installer-managed": "8cfabdac73530cfdef2389017e9d4ce4a2f1c8ad6317e83c4f5bf2284ca38803",
  "operator-provisioned": "a178674662bd91eafd9607be4f3c607f276e5195cf4efbb59e5b822b46646888",
};
const profiles = ["bootstrap", "separate", "installer-managed", "operator-provisioned"] as const;
type Profile = typeof profiles[number];

// Removed restore admissions from origin/main at d250c10607ecf5b122aeee7f6b70c98ed830522b.
const deletedInventories = {
  beforePublicationCommands: {
    bootstrap: "1c9190ad0520e6ce8229a81ed9ba756da528986d19cad09fc1716d72dadd70c0",
    separate: "c19175002e39e2b4100841e7138759a4dd07fe3158ebd3ce5f7283a5e8d538a9",
    "installer-managed": "10be382792deaf1cb8f7c1620984d3c47a5c7e8b1cb1634aa7e44374370d2c00",
    "operator-provisioned": "9979a84636b80febb605161e2df5fe14b59ad975781b697bd42fee0dcd9dc71c",
  },
  beforeCheckoutAttemptLedger: {
    bootstrap: "df04bdf1590aae92df0fe1885a90a6f7d8c25075a38b3e57a5a66f9bb358eadb",
    separate: "0fca9c01fd08e76700cd55eaafb81ff1dd9f265ed9a672d3c9936812c8df1153",
    "installer-managed": "955596b9524fa304df1240b3e170d920c1ba27aefc366fb436c78bf7abb326b5",
    "operator-provisioned": "443cb07abc88ad43dd3c712310b31204f242b50793fc40d0a5e5ba8765995017",
  },
  beforeGovernedLifecycle: {
    bootstrap: "25bc3a527c27eb205c60b26e388d475bc8532638e66537438e60659a77214f20",
    separate: "b80abf637c8f3f6f854fcac09c88c6b9774857f93c41f0f94664e20f7e62b385",
    "installer-managed": "37df11b3df727367715dcabaff16e366fac0477c8a09167d3f180e31746b82c4",
    "operator-provisioned": "4c05ab3d6ed00157305853bdfd272469feabc03c6528aab3d6eec7a7e7a2d8ac",
  },
  beforeAcceptedReferences: {
    bootstrap: "ec9028a590334948606d160362e9363c50793284548c2b9c092a71632234724c",
    separate: "1feea98acf1cd7cdf1de399cdf8ab8c9ff6a30cec67168a274428f05f4722638",
    "installer-managed": "02c68db9202830bd08f574130d3a3de19345a4050b8879d3338824b379474195",
    "operator-provisioned": "a05e24a7dcdc6cb4394907be818520a33fa89e9a269a7c01853cd656ecfcf91b",
  },
  beforeSubscriptionProfiles: {
    bootstrap: "c6fea6b7fe85a7963f952994c34e1dfbca87045952e3dadbbf947c4b89aab5f6",
    separate: "d0a803fd96d5fe048179cff18181c437ede56daa3a8dc14b2ee0a62381753619",
    "installer-managed": "412caa25526d6ba70bb5bb761d5bed2336e7307811a879658295819ad5ab15f5",
    "operator-provisioned": "d413c04713b9fb5f5f9d8f01dc66c68c67d131f6cc94bcbf12becef47abd4f42",
  },
  beforeAcquisitionSearchPathPin: {
    bootstrap: "cffdddea783d1cdbc1460c6a9d6caf5bad4a94096eacd38938bdb6b6b28bc256",
    separate: "d7a7452c78bc5d1b3fc3920d483a2465f8a64caf2198238d9e8e494f52e168c5",
    "installer-managed": "beaa7e249a4a9966f48a6fe9a99c48900a7b228cc22e2178bdd42df5a56fc474",
    "operator-provisioned": "5c43ca0f133bffc0d3e2eebf826c1932272a0309b45add51d21cfa97d430d673",
  },
} satisfies Record<string, Record<Profile, string>>;

const logins = { bootstrapLogin: "postgres", migrationLogin: "store_migrator", runtimeLogin: "store_runtime", restoreLogin: "store_restore" };
const installations = {
  bootstrap: { ...logins, generation: "qualified-v2", roleMode: "installer-managed", migrationLogin: logins.bootstrapLogin },
  separate: { ...logins, generation: "qualified-v2", roleMode: "installer-managed" },
  "installer-managed": { ...logins, generation: "qualified-admin", roleMode: "installer-managed" },
  "operator-provisioned": { ...logins, generation: "qualified-admin", roleMode: "operator-provisioned", operatorLogin: "store_operator" },
} satisfies Record<Profile, QualifiedPostgresInstallation | QualifiedAdminPostgresInstallation>;

function currentInventory(profile: Profile) {
  const manifest = readPlatformMigrationManifest(process.cwd()) as PlatformMigrationManifest | null;
  if (manifest?.schemaVersion !== 3) throw new Error("Qualified installation inventories required");
  const qualified = manifest.qualified.objectInventorySha256;
  const admin = manifest.qualifiedAdmin.objectInventorySha256;
  return {
    bootstrap: qualified.bootstrapMigrator.withRestore,
    separate: qualified.separateMigrator.withRestore,
    "installer-managed": admin.installerManaged,
    "operator-provisioned": admin.operatorProvisioned,
  }[profile];
}

it.each(profiles)("routes current and unsupported inventories for %s", profile => {
  const current = currentInventory(profile);
  expect(connectedStoreSourceShape(profile, current, current)).toBe("current");
  expect(connectedStoreSourceShape(profile, released[profile], current)).toBe("unsupported");
  expect(connectedStoreSourceShape(profile, undefined, current)).toBe("unsupported");
  for (const [boundary, inventories] of Object.entries(deletedInventories)) {
    for (const [sourceProfile, pin] of Object.entries(inventories)) {
      expect(connectedStoreSourceShape(profile, pin, current), `${boundary} ${sourceProfile}`).toBe("unsupported");
    }
  }
});

const digest = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
type CompatibleTable = ConnectedNativeStoreCapture["compatible"]["tables"][number]["table"];
type OwnedTable = ConnectedNativeStoreCapture["owned"][number]["table"];
const ownedStart = connectedNativeStoreTables.indexOf("commerce_promotion_definitions");
const editQuotes = "subscription_edit_quotes";

function captureFixture(sourceId: string, catalogueId: string, login: string, preLedger = false): ConnectedNativeStoreCapture {
  // Empty synthetic rows and the complete roster for pre-connection validation.
  const compatibleTables = connectedNativeStoreTables.slice(0, ownedStart) as CompatibleTable[];
  const ownedTables = connectedNativeStoreTables.slice(ownedStart) as OwnedTable[];
  const columns = [{ name: "id", type: "uuid" }];
  const tables = compatibleTables
    .filter(table => !(preLedger && table === "commerce_checkout_attempt_ledger"))
    .map(table => ({ table, columns: [{ ...columns[0], key: true }], rows: [] }));
  const owned = ownedTables.filter(table => !(preLedger && table === editQuotes)).map(table => ({ table, columns, rows: [] }));
  const compatible = { format: "openlup.compatible-rows.v1" as const, sourceId, catalogueId, tables };
  const relation = `public.${editQuotes}`;
  const body = {
    format: "openlup.native-retained-store.v1",
    compatible: { ...compatible, sha256: digest(compatible) },
    observation: { cluster: sourceId, database: "store", login, snapshot: "1" },
    // The old adapter required proof that this omitted table was empty.
    outsideProfileCensus: preLedger ? [{ relation, owner: login, disposition: "unsupported-empty", rows: "0" }] : [],
    emptyOutsideProfile: preLedger ? [relation] : [],
    requiredPrivacyContributorIds: ["identity"],
    owned,
  } satisfies Omit<ConnectedNativeStoreCapture, "sha256">;
  return { ...body, sha256: digest(body) };
}

it.each([
  ...profiles.map(profile => ({ profile, version: "1.3.0", catalogueId: released[profile] })),
  { profile: "separate", version: "pre-ledger", catalogueId: deletedInventories.beforeCheckoutAttemptLedger.separate },
  { profile: "separate", version: "before the privacy declaration", catalogueId: "ed809bbddd2486eef73f0d6bafbb1a69f4ffe55cc0055b4e6c356a66fdaec940" },
] as const)("refuses the $version $profile inventory before connecting", async ({ profile, version, catalogueId }) => {
  const installation = installations[profile];
  const packet = captureFixture("source", catalogueId, logins.bootstrapLogin, version === "pre-ledger");
  const freshTarget = captureFixture("target", currentInventory(profile), installation.migrationLogin);
  const connect = vi.fn().mockRejectedValue(new Error("unexpected database connection"));
  await expect(restoreConnectedNativeStore({
    owner: { connect } as unknown as Pool,
    installation,
    packet,
    freshTarget,
  })).rejects.toMatchObject({
    code: "schema_conflict",
    remedy: "capture the source and restore it with the same OpenLup version on a pristine target of the same profile; upgrade the source within its installed profile first if it is older",
  });
  expect(connect).not.toHaveBeenCalled();
});

it.each([[], ["identity", "identity"], ["identity", "first"], ["other"], ["Bad", "identity"]])(
  "refuses a malformed current contributor census before connecting (%j)", async (...ids) => {
    const installation = installations.separate, pin = currentInventory("separate");
    const { sha256: _hash, ...source } = captureFixture("source", pin, logins.bootstrapLogin);
    const body = { ...source, requiredPrivacyContributorIds: ids };
    const freshTarget = captureFixture("target", pin, installation.migrationLogin);
    const connect = vi.fn().mockRejectedValue(new Error("unexpected database connection"));
    await expect(restoreConnectedNativeStore({ owner: { connect } as unknown as Pool, installation,
      packet: { ...body, sha256: digest(body) }, freshTarget })).rejects.toMatchObject({ code: "invalid_input" });
    expect(connect).not.toHaveBeenCalled();
  },
);
