import { createHash } from "node:crypto";
import type { Pool } from "pg";
import { expect, it, vi } from "vitest";
import { readPlatformMigrationManifest, type PlatformMigrationManifest } from "../../../scripts/platform-migration-manifest.js";
import type { ConnectedNativeStoreCapture } from "./connectedStoreCapture.js";
import { connectedStoreSourceShape, restoreConnectedNativeStore } from "./connectedStoreRestore.js";
import type { QualifiedAdminPostgresInstallation, QualifiedPostgresInstallation } from "./qualifiedInstall.js";

// From openlup-platform-v1.3.0:tests/postgres/current-installation-inventory.json.
const released = {
  bootstrap: "b0e5b3ac447383aec5cd6185f9b24b0d669a1416a40ef9313490c16a5716d158",
  separate: "251787e365f84f52f45692256850352af5b104baeef10395fd3a8b74949613d6",
  "installer-managed": "8cfabdac73530cfdef2389017e9d4ce4a2f1c8ad6317e83c4f5bf2284ca38803",
  "operator-provisioned": "a178674662bd91eafd9607be4f3c607f276e5195cf4efbb59e5b822b46646888",
};
const logins = { bootstrapLogin: "postgres", migrationLogin: "store_migrator", runtimeLogin: "store_runtime", restoreLogin: "store_restore" };
const installations = {
  bootstrap: { ...logins, generation: "qualified-v2", roleMode: "installer-managed", migrationLogin: logins.bootstrapLogin },
  separate: { ...logins, generation: "qualified-v2", roleMode: "installer-managed" },
  "installer-managed": { ...logins, generation: "qualified-admin", roleMode: "installer-managed" },
  "operator-provisioned": { ...logins, generation: "qualified-admin", roleMode: "operator-provisioned", operatorLogin: "store_operator" },
} satisfies Record<keyof typeof released, QualifiedPostgresInstallation | QualifiedAdminPostgresInstallation>;
const profiles = ["bootstrap", "separate", "installer-managed", "operator-provisioned"] as const;

it.each(profiles)("routes current and unsupported inventories for %s", profile => {
  const manifest = readPlatformMigrationManifest(process.cwd()) as PlatformMigrationManifest | null;
  if (manifest?.schemaVersion !== 3) throw new Error("Qualified installation inventories required");
  const qualified = manifest.qualified.objectInventorySha256;
  const admin = manifest.qualifiedAdmin.objectInventorySha256;
  const current = {
    bootstrap: qualified.bootstrapMigrator.withRestore,
    separate: qualified.separateMigrator.withRestore,
    "installer-managed": admin.installerManaged,
    "operator-provisioned": admin.operatorProvisioned,
  }[profile];
  expect(connectedStoreSourceShape(profile, current, current)).toBe("current");
  expect(connectedStoreSourceShape(profile, released[profile], current)).toBe("unsupported");
  expect(connectedStoreSourceShape(profile, undefined, current)).toBe("unsupported");
});

it.each([
  ...profiles.map(profile => ({ profile, version: "1.3.0", catalogueId: released[profile] })),
  { profile: "separate", version: "pre-ledger", catalogueId: "0fca9c01fd08e76700cd55eaafb81ff1dd9f265ed9a672d3c9936812c8df1153" },
] as const)("refuses the $version $profile inventory before connecting", async ({ profile, catalogueId }) => {
  const digest = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
  const compatible = { format: "openlup.compatible-rows.v1" as const, sourceId: "prior-inventory", catalogueId, tables: [] };
  const body = {
    format: "openlup.native-retained-store.v1",
    compatible: { ...compatible, sha256: digest(compatible) },
    observation: { cluster: "source", database: "store", login: "postgres", snapshot: "1" },
    outsideProfileCensus: [], emptyOutsideProfile: [], owned: [],
  } satisfies Omit<ConnectedNativeStoreCapture, "sha256">;
  const packet = { ...body, sha256: digest(body) };
  const connect = vi.fn();
  await expect(restoreConnectedNativeStore({
    owner: { connect } as unknown as Pool,
    installation: installations[profile],
    packet,
    freshTarget: packet,
  })).rejects.toMatchObject({ code: "schema_conflict", remedy: "upgrade the source, then capture" });
  expect(connect).not.toHaveBeenCalled();
});
