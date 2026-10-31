import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { QUALIFIED_OWNER_PATH_FILE, QUALIFIED_RUNTIME_COMPLETION_FILE, type PlatformMigrationManifest } from "../../scripts/platform-migration-manifest.js";

/** Frozen M14 reference inventories: never replace these with an observed target. */
export function readIssuedPlatformManifest() {
  const issued = JSON.parse(readFileSync("config/platform-migration-manifest.json", "utf8")) as PlatformMigrationManifest;
  if (issued.schemaVersion !== 3) throw new Error("Issued-prefix witness requires the three platform plans");
  for (const [plan, tail] of [
    [issued, "db/platform/migrations/20261026120000_account_support_operator_authority.sql"],
    [issued.qualified, QUALIFIED_OWNER_PATH_FILE],
    [issued.qualifiedAdmin, QUALIFIED_RUNTIME_COMPLETION_FILE],
  ] as const) {
    const end = plan.forward.findIndex(entry => entry.file === tail);
    if (end < 0) throw new Error("Issued-prefix witness tail missing: " + tail);
    plan.forward = plan.forward.slice(0, end + 1);
  }
  issued.objectInventorySha256 = "cfe3a8b4fa6216f61b1cdd5f004cb0f7a967bc01d9e18ddacb2efee74742d3b3";
  issued.qualified.objectInventorySha256 = {
    bootstrapMigrator: { withRestore: "c4f6bb9daa5882877149a78e13d07594b7e8653c3a3ba39f508477b072548f9b" },
    separateMigrator: { withRestore: "624cc57789e3aaf36d0b61bdad420fc4eb0b63c2a7eb09358e5c18240ec13f82" },
  };
  issued.qualifiedAdmin.objectInventorySha256 = {
    installerManaged: "c94d71fd28d5571cda30307bce4c4b48ebe0a3685c76819d8fa3b3efa8fa9ae7",
    operatorProvisioned: "807ea0c9b303c04c4ad3e9892ab16ee7e89acaea8b7641d1cedd4c79949fab7d",
  };
  return issued;
}

/** Existing runner root seam: install the fixed issued prefix, then the live suffix. */
export async function withIssuedPlatformCatalog<T>(work: (root: string) => Promise<T>): Promise<T> {
  const issued = readIssuedPlatformManifest();
  const root = mkdtempSync(join(tmpdir(), "openlup-issued-prefix-"));
  try {
    const paths = new Set([issued, issued.qualified, issued.qualifiedAdmin].flatMap(plan =>
      [plan.baseline.file, ...plan.forward.map(entry => entry.file)]));
    for (const file of paths) {
      const target = join(root, file);
      mkdirSync(dirname(target), { recursive: true });
      cpSync(file, target);
    }
    mkdirSync(join(root, "config"));
    writeFileSync(join(root, "config/platform-migration-manifest.json"), JSON.stringify(issued));
    return await work(root);
  } finally { rmSync(root, { recursive: true, force: true }); }
}
