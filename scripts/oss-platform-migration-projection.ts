import { computeNeutralizations, type PublicCoordinateProfile } from "./oss-neutralization-projection.ts";
import { evaluatePlatformMigrationManifest, PLATFORM_MIGRATION_MANIFEST, sha256, type PlatformMigrationManifest } from "./platform-migration-manifest.ts";
import type { SourceReceiptEnvelope } from "./oss-consume-github-transport.ts";

export type PlatformMigrationProjectionInput = {
  sourceManifestRaw: string;
  sourceMigrationBytes: Record<string, string>;
  profile?: PublicCoordinateProfile;
};
export type PlatformMigrationProjection = PlatformMigrationProjectionInput & {
  publicManifestRaw: string;
  publicMigrationBytes: Record<string, string>;
};

/** Remove only SQL line comments outside quoted bodies/values and block comments.
 * A comment inside a stored routine is part of pg_get_functiondef and must stay.
 * This deliberately proves byte equality, not general SQL semantic equivalence.
 */
function withoutExternalLineComments(sql: string): string {
  let output = "", quote = "", blockDepth = 0;
  for (let index = 0; index < sql.length;) {
    if (quote) {
      if (sql.startsWith(quote, index)) {
        output += quote; index += quote.length;
        if (quote.length === 1 && sql.startsWith(quote, index)) { output += quote; index++; }
        else quote = "";
      } else if (quote === "'" && sql[index] === "\\") {
        // Conservatively keep escaped characters in string state, including E''.
        output += sql.slice(index, index + 2); index += 2;
      } else { output += sql[index]; index++; }
    } else if (blockDepth) {
      if (sql.startsWith("/*", index)) { blockDepth++; output += "/*"; index += 2; }
      else if (sql.startsWith("*/", index)) { blockDepth--; output += "*/"; index += 2; }
      else { output += sql[index]; index++; }
    } else if (sql.startsWith("--", index)) {
      const end = sql.indexOf("\n", index); index = end < 0 ? sql.length : end;
    } else if (sql.startsWith("/*", index)) { blockDepth = 1; output += "/*"; index += 2; }
    else {
      const dollar = /^\$(?:[A-Za-z_\u0080-\u{10FFFF}][A-Za-z0-9_\u0080-\u{10FFFF}]*)?\$/u.exec(sql.slice(index))?.[0];
      if (sql[index] === "'" || sql[index] === '"' || dollar) {
        quote = dollar ?? sql[index]!; output += quote; index += quote.length;
      } else { output += sql[index]; index++; }
    }
  }
  if (quote || blockDepth) throw new Error("platform projection: unterminated SQL quotation/comment");
  return output;
}

/** Exact private input plus its fixed public projection, never a target-supplied base. */
export function computePlatformMigrationProjection(input: PlatformMigrationProjectionInput): PlatformMigrationProjection {
  const source: unknown = JSON.parse(input.sourceManifestRaw);
  const migrations = Object.entries(input.sourceMigrationBytes).map(([file, content]) => ({ file, content }));
  const errors = evaluatePlatformMigrationManifest({ manifest: source, migrations });
  if (errors.length) throw new Error(`platform projection source refused: ${errors.join("; ")}`);
  const manifest = source as PlatformMigrationManifest;
  const publicMigrationBytes = { ...input.sourceMigrationBytes };
  for (const { path, contents } of computeNeutralizations(new Map(Object.entries(input.sourceMigrationBytes)), input.profile).writes) {
    if (withoutExternalLineComments(input.sourceMigrationBytes[path]!) !== withoutExternalLineComments(contents)) {
      throw new Error(`platform projection changes stored SQL/object identity: ${path}`);
    }
    publicMigrationBytes[path] = contents;
  }
  const entry = ({ file }: { file: string }) => ({ file, sha256: sha256(publicMigrationBytes[file]!) });
  const projected = { ...manifest, baseline: entry(manifest.baseline), forward: manifest.forward.map(entry) };
  const publicManifestRaw = `${JSON.stringify(projected, null, 2)}\n`;
  const projectedErrors = evaluatePlatformMigrationManifest({ manifest: projected, migrations: Object.entries(publicMigrationBytes).map(([file, content]) => ({ file, content })) });
  if (projectedErrors.length) throw new Error(`platform projection output refused: ${projectedErrors.join("; ")}`);
  return { ...input, publicManifestRaw, publicMigrationBytes };
}

/** Structural proof used only after the private caller authenticates exact S/S6 and the public root. */
export function assertInitialPlatformMigrationProjection(input: PlatformMigrationProjectionInput & {
  receipt: SourceReceiptEnvelope;
  targetManifestRaw: string;
  targetMigrationBytes: Record<string, string>;
}): PlatformMigrationProjection {
  if (input.receipt.schemaVersion !== 4 || input.receipt.evidenceClass !== "activation-candidate" || input.receipt.export.parents.length !== 0 || !input.profile
    || input.profile.repository !== input.receipt.identity.repository || input.profile.securityRoute !== input.receipt.identity.securityRoute) {
    throw new Error("initial platform projection requires the authenticated initial root/profile");
  }
  const projection = computePlatformMigrationProjection(input);
  if (projection.publicManifestRaw !== input.targetManifestRaw
    || JSON.stringify(Object.keys(projection.publicMigrationBytes).sort()) !== JSON.stringify(Object.keys(input.targetMigrationBytes).sort())
    || Object.entries(projection.publicMigrationBytes).some(([path, bytes]) => input.targetMigrationBytes[path] !== bytes)) {
    throw new Error("initial platform target differs from the independently derived source projection");
  }
  const rows = [
    [PLATFORM_MIGRATION_MANIFEST, input.sourceManifestRaw, projection.publicManifestRaw],
    ...Object.entries(input.sourceMigrationBytes).filter(([path, bytes]) => bytes !== projection.publicMigrationBytes[path]).map(([path, bytes]) => [path, bytes, projection.publicMigrationBytes[path]!]),
  ];
  for (const [path, source, target] of rows) {
    const matching = input.receipt.drift.filter((row) => row.selector === path);
    const row = matching[0];
    if (matching.length !== 1 || row?.class !== "projection" || row.sourceSelector !== path
      || row.source.disposition !== "present" || row.source.digest !== `sha256:${sha256(source!)}`
      || row.public.disposition !== "projected" || row.public.digest !== `sha256:${sha256(target!)}`) {
      throw new Error(`initial platform projection receipt identity differs: ${path}`);
    }
    const disclosed = input.receipt.disclosure.paths.filter((entry) => entry.path === path);
    if (disclosed.length !== 1 || disclosed[0]?.mode !== "100644" || disclosed[0].digest !== `sha256:${sha256(target!)}`) {
      throw new Error(`initial platform projection disclosure bytes/mode differ: ${path}`);
    }
  }
  return projection;
}
