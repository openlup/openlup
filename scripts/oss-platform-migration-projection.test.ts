import { readFileSync, readdirSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { assertInitialPlatformMigrationProjection, computePlatformMigrationProjection } from "./oss-platform-migration-projection.ts";
import { PLATFORM_BASELINE_FILE, PLATFORM_MIGRATION_DIRECTORY, PLATFORM_MIGRATION_MANIFEST, sha256 } from "./platform-migration-manifest.ts";
import type { SourceReceiptEnvelope } from "./oss-consume-github-transport.ts";

const profile = { repository: "https://github.com/openlup/openlup", securityRoute: "dev@openlup.com" };
// Assemble a synthetic repository coordinate so publishing this falsifier does
// not neutralize the literal it needs to feed back into the detector.
const privateHost = ["https://github.com/example", "app"].join("/");
const source = (sql = `-- source ${privateHost}\nCREATE TABLE example (id integer);\n`) => ({
  sourceManifestRaw: `${JSON.stringify({ schemaVersion: 1, baseline: { file: PLATFORM_BASELINE_FILE, sha256: sha256(sql) }, forward: [], objectInventorySha256: sha256("objects") }, null, 2)}\n`,
  sourceMigrationBytes: { [PLATFORM_BASELINE_FILE]: sql }, profile,
});
function fixture() {
  const input = source(), projected = computePlatformMigrationProjection(input);
  const entries = [[PLATFORM_MIGRATION_MANIFEST, input.sourceManifestRaw, projected.publicManifestRaw], [PLATFORM_BASELINE_FILE, input.sourceMigrationBytes[PLATFORM_BASELINE_FILE]!, projected.publicMigrationBytes[PLATFORM_BASELINE_FILE]!]];
  const receipt = {
    schemaVersion: 4, evidenceClass: "activation-candidate", identity: { ...profile, evidenceClass: "activation-candidate", owner: { name: "OpenLup Maintainer", email: "maintainer@openlup.com" } },
    contract: { path: "config/openlup-source-release-contract.json", digest: `sha256:${sha256("contract")}` }, export: { commit: "a".repeat(40), tree: "b".repeat(40), parents: [] },
    drift: entries.map(([selector, before, after]) => ({ class: "projection", selector, sourceSelector: selector, source: { disposition: "present", digest: `sha256:${sha256(before!)}` }, public: { disposition: "projected", digest: `sha256:${sha256(after!)}` } })),
    disclosure: { allowlist: { schemaVersion: 1, digest: `sha256:${sha256("allowlist")}` }, paths: entries.map(([path, , bytes]) => ({ path, mode: "100644", digest: `sha256:${sha256(bytes!)}` })), releaseNote: { digest: `sha256:${sha256("note")}` }, tag: null },
  } as SourceReceiptEnvelope;
  return { ...input, receipt, targetManifestRaw: projected.publicManifestRaw, targetMigrationBytes: projected.publicMigrationBytes };
}

describe("exact initial platform migration projection", () => {
  it("binds the final public SQL while retaining the original private identity and object inventory", () => {
    const input = fixture(), result = assertInitialPlatformMigrationProjection(input);
    expect(result.publicManifestRaw).not.toBe(result.sourceManifestRaw);
    expect(JSON.parse(result.publicManifestRaw).objectInventorySha256).toBe(JSON.parse(result.sourceManifestRaw).objectInventorySha256);
    expect(result.sourceMigrationBytes).toEqual(input.sourceMigrationBytes);
    expect(result.publicMigrationBytes[PLATFORM_BASELINE_FILE]).not.toContain(privateHost);
  });
  it.each([
    `CREATE FUNCTION example() RETURNS text AS $$ BEGIN\n-- ${privateHost}\nRETURN 'x'; END $$ LANGUAGE plpgsql;`,
    `CREATE FUNCTION example() RETURNS text AS $body$ SELECT '${privateHost}' $body$ LANGUAGE sql;`,
    `CREATE FUNCTION example() RETURNS text AS $ciało$ BEGIN\n-- ${privateHost}\nRETURN 'x'; END $ciało$ LANGUAGE plpgsql;`,
    `COMMENT ON TABLE example IS '${privateHost}';`,
    `/* ${privateHost} */\nCREATE TABLE example(id integer);`,
  ])("refuses a change inside stored/quoted/block-comment SQL: %s", (sql) => {
    expect(() => computePlatformMigrationProjection(source(sql))).toThrow(/stored SQL\/object identity/);
  });
  it("refuses malformed source hashes, membership and SQL quoting before deriving anything", () => {
    const input = source();
    expect(() => computePlatformMigrationProjection({ ...input, sourceMigrationBytes: { [PLATFORM_BASELINE_FILE]: "changed" } })).toThrow(/SHA-256 mismatch/);
    expect(() => computePlatformMigrationProjection({ ...input, sourceMigrationBytes: {} })).toThrow(/missing catalog/);
    expect(() => computePlatformMigrationProjection(source(`-- ${privateHost}\nSELECT 'unterminated`))).toThrow(/unterminated/);
  });
  it.each(["target-bytes", "target-manifest", "receipt-row", "source-digest", "public-digest", "mode", "profile", "descendant"])("refuses %s substitution", (kind) => {
    const input = fixture();
    if (kind === "target-bytes") input.targetMigrationBytes[PLATFORM_BASELINE_FILE] += "SELECT 1;\n";
    if (kind === "target-manifest") input.targetManifestRaw += "\n";
    if (kind === "receipt-row") input.receipt.drift.pop();
    if (kind === "source-digest") input.receipt.drift[0]!.source.digest = `sha256:${sha256("wrong")}`;
    if (kind === "public-digest") input.receipt.drift[0]!.public.digest = `sha256:${sha256("wrong")}`;
    if (kind === "mode") input.receipt.disclosure.paths[0]!.mode = "100755";
    if (kind === "profile") input.profile = { ...profile, securityRoute: "wrong@example.org" };
    if (kind === "descendant") Object.assign(input.receipt, { schemaVersion: 5, export: { ...input.receipt.export, parents: ["c".repeat(40)] } });
    expect(() => assertInitialPlatformMigrationProjection(input)).toThrow();
  });
  it("projects the complete tracked platform chain without a semantic/object identity change", () => {
    const sourceManifestRaw = readFileSync(PLATFORM_MIGRATION_MANIFEST, "utf8");
    const sourceMigrationBytes = Object.fromEntries(readdirSync(PLATFORM_MIGRATION_DIRECTORY).filter((path) => path.endsWith(".sql")).map((path) => [`${PLATFORM_MIGRATION_DIRECTORY}/${path}`, readFileSync(`${PLATFORM_MIGRATION_DIRECTORY}/${path}`, "utf8")]));
    const result = computePlatformMigrationProjection({ sourceManifestRaw, sourceMigrationBytes, profile });
    const before = JSON.parse(sourceManifestRaw), after = JSON.parse(result.publicManifestRaw);
    expect([after.baseline, ...after.forward].map(({ file }: { file: string }) => file)).toEqual([before.baseline, ...before.forward].map(({ file }: { file: string }) => file));
    expect(after.objectInventorySha256).toBe(before.objectInventorySha256);
    expect(after.baseline.sha256).toBe(sha256(result.publicMigrationBytes[PLATFORM_BASELINE_FILE]!));
  });
});
