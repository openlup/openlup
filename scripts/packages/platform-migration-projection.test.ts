import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { expect, it } from "vitest";
import { checkPlatformMigrationProjection } from "./platform-migration-projection.ts";

it("generates exact canonical identities and refuses manifest/SQL drift", () => {
  const root = mkdtempSync(join(tmpdir(), "platform-projection-"));
  try {
    mkdirSync(join(root, "scripts"));
    mkdirSync(join(root, "packages/platform/src/migrations"), {recursive:true});
    writeFileSync(join(root, "scripts/platform-migration-manifest.ts"), "export {};\n");
    mkdirSync(join(root, "config")); mkdirSync(join(root, "db/platform/migrations"), {recursive:true});
    mkdirSync(join(root, "packages/platform/sql"), {recursive:true});
    const content = "SELECT 1;\n", file = "db/platform/migrations/00000000000000_platform_baseline.sql";
    const canonical = {schemaVersion:1,baseline:{file,sha256:createHash("sha256").update(content).digest("hex")},forward:[],objectInventorySha256:"0".repeat(64)};
    writeFileSync(join(root, "config/platform-migration-manifest.json"), JSON.stringify(canonical));
    writeFileSync(join(root,file),content);
    expect(checkPlatformMigrationProjection(root,true)).toEqual([]);
    writeFileSync(join(root, "packages/platform/src/migrations/catalog.ts"), "// drift\n");
    expect(checkPlatformMigrationProjection(root)).toContain("packaged migration selection drift: scripts/platform-migration-manifest.ts");
    checkPlatformMigrationProjection(root,true);
    const manifest = join(root,"packages/platform/sql/manifest.json"), sql = join(root,"packages/platform/sql/00000000000000_platform_baseline.sql");
    expect(JSON.parse(readFileSync(manifest,"utf8")).catalog).toEqual(canonical);
    writeFileSync(manifest,"{}\n");
    expect(checkPlatformMigrationProjection(root)).toContain("packaged platform migration manifest drift: regenerate the package projection (packages/platform/README.md)");
    checkPlatformMigrationProjection(root,true);
    writeFileSync(sql,"SELECT 2;\n");
    expect(checkPlatformMigrationProjection(root)).toContain(`packaged migration drift: ${file}`);
    rmSync(sql);
    expect(checkPlatformMigrationProjection(root)).toContain(`packaged migration missing: ${file}`);
  } finally { rmSync(root,{recursive:true,force:true}); }
});
