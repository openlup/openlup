/** Read the existing producer's exact artifact set; never build or repack on refusal. */
import { env as processEnvironment } from "node:process";
import { createHash } from "node:crypto";
import { lstatSync, readFileSync, readdirSync, realpathSync } from "node:fs";
import { dirname, join, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";
import { parsePackagesConfig } from "./package-manifest-policy.ts";

export type ExpectedPackage = { name: string; version: string };
export type VerifiedPack = ExpectedPackage & { path: string; sha256: string; integrity: string };
function fail(detail: string): never { throw new Error(`pack-manifest: ${detail}`); }
const object = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value);

export function readPackManifest(manifestPath: string, expectedCommit: string, expectedPackages: readonly ExpectedPackage[]): Map<string, VerifiedPack> {
  if (!/^[a-f0-9]{40}$/u.test(expectedCommit)) fail("expected commit must be a full SHA");
  const path = resolve(manifestPath), directory = dirname(path);
  if (!lstatSync(path).isFile() || lstatSync(path).isSymbolicLink()) fail("manifest must be an ordinary file");
  const manifest: unknown = JSON.parse(readFileSync(path, "utf8"));
  if (!object(manifest) || manifest.schemaVersion !== 2 || manifest.commit !== expectedCommit || !Array.isArray(manifest.packages)) fail("schema or candidate identity mismatch");
  if (Object.keys(manifest).some((key) => !["schemaVersion", "commit", "packages"].includes(key))) fail("unknown manifest input");
  const expected = new Map(expectedPackages.map((entry) => [entry.name, entry.version]));
  if (expected.size === 0 || expected.size !== expectedPackages.length) fail("expected package set is empty or duplicated");
  const result = new Map<string, VerifiedPack>(), filenames = new Set<string>();
  for (const entry of manifest.packages) {
    if (!object(entry) || typeof entry.name !== "string" || entry.version !== expected.get(entry.name) || !expected.has(entry.name)) fail("unexpected package/version");
    if (Object.keys(entry).sort().join(",") !== "filename,integrity,name,sha256,version") fail("unknown package input");
    if (typeof entry.filename !== "string" || !/^[a-zA-Z0-9][a-zA-Z0-9._-]*\.tgz$/u.test(entry.filename) || filenames.has(entry.filename) || result.has(entry.name)) fail("unsafe or duplicated artifact name");
    const artifact = join(directory, entry.filename), stat = lstatSync(artifact);
    if (!stat.isFile() || stat.isSymbolicLink() || dirname(realpathSync(artifact)) !== realpathSync(directory)) fail("artifact must be an ordinary confined file");
    const bytes = readFileSync(artifact), sha256 = createHash("sha256").update(bytes).digest("hex"), integrity = `sha512-${createHash("sha512").update(bytes).digest("base64")}`;
    if (entry.sha256 !== sha256 || entry.integrity !== integrity) fail(`digest mismatch for ${entry.name}`);
    filenames.add(entry.filename);
    result.set(entry.name, { name: entry.name, version: entry.version as string, path: artifact, sha256, integrity });
  }
  if (result.size !== expected.size || [...expected.keys()].some((name) => !result.has(name))) fail("incomplete package set");
  const listed = new Set([path.slice(directory.length + 1), ...filenames]);
  if (readdirSync(directory).some((name) => !listed.has(name)) || listed.size !== readdirSync(directory).length) fail("unlisted artifact directory contents");
  return result;
}

/** Test tooling is explicit; ancestor/workspace module overrides cannot satisfy an import. */
export function isolatedConsumerEnv(): NodeJS.ProcessEnv {
  const environment = { ...processEnvironment };
  delete environment.NODE_PATH;
  delete environment.NODE_OPTIONS;
  delete environment.npm_config_node_options;
  delete environment.NPM_CONFIG_NODE_OPTIONS;
  return environment;
}

export function readCurrentPackManifest(root: string, manifest: string, commit: string): Map<string, VerifiedPack> {
  const expected = parsePackagesConfig(readFileSync(join(root, "config/openlup-packages.json"), "utf8")).packages.filter(({ publish }) => publish).map(({ name, directory }) => {
    const metadata = JSON.parse(readFileSync(join(root, directory, "package.json"), "utf8"));
    if (metadata.name !== name || typeof metadata.version !== "string") fail("invalid current package inventory");
    return { name, version: metadata.version as string };
  });
  return readPackManifest(manifest, commit, expected);
}

// Core's package boundary forbids importing root source. Its existing consumer
// invokes this root-owned tool, whose expected set is the current closed inventory.
if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) {
  const [manifest, commit] = process.argv.slice(2);
  if (!manifest || !commit || process.argv.length !== 4) fail("use manifest-path expected-full-commit");
  console.log(JSON.stringify([...readCurrentPackManifest(process.cwd(), manifest, commit).values()]));
}

export function assertInstalledPackages(consumerDir: string, names: readonly string[]): void {
  const root = realpathSync(consumerDir);
  for (const name of names) {
    const path = join(root, "node_modules", name);
    if (!lstatSync(path).isDirectory() || lstatSync(path).isSymbolicLink() || !realpathSync(path).startsWith(`${root}${sep}`)) fail(`installed ${name} is not a confined ordinary directory`);
  }
}
