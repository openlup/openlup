import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { isolatedConsumerEnv } from "./pack-manifest-input.ts";
import { RELEASE_VERSION } from "./package-manifest-policy.ts";

const registry = "https://registry.npmjs.org";
type Release = { name: string; version: string; integrity: string; tarball: string };
export type Pack = { path: string; name?: string; version?: string };
type Manifest = {
  name: string;
  version: string;
  exports: Record<string, unknown>;
  dependencies?: Record<string, string>;
  peerDependencies?: Record<string, string>;
  optionalDependencies?: Record<string, string>;
};

export function baselineRefusal(detail: string): never {
  throw new Error(`Released API baseline: ${detail}. Check npm's latest tags and exact peer pins. If a set is publishing, retry after all packages are visible; for local verification supply two complete pack sets.`);
}

function coherentVersion(packs: { name: string; version: string }[]): string {
  const version = packs[0]?.version;
  if (!version || !RELEASE_VERSION.test(version) || version.startsWith("0.")) baselineRefusal("missing stable version");
  if (packs.some(pack => pack.version !== version)) baselineRefusal(`mixed set (${packs.map(pack => `${pack.name}@${pack.version}`).join(", ")})`);
  return version;
}

export async function resolveLatest(names: string[], request = fetch): Promise<Release[]> {
  const releases = await Promise.all(names.map(async name => {
    const response = await request(`${registry}/${name.replace("/", "%2f")}/latest`, {
      headers: { "cache-control": "no-cache" }, signal: AbortSignal.timeout(15_000),
    }).catch(() => baselineRefusal(`could not reach npm for ${name}@latest`));
    if (!response.ok) baselineRefusal(`missing ${name}@latest (npm HTTP ${response.status})`);
    const release = await response.json().catch(() => baselineRefusal(`invalid npm metadata for ${name}@latest`)) as { name?: string; version?: string; dist?: { integrity?: string; tarball?: string } };
    const { integrity, tarball } = release?.dist ?? {};
    const exact = `${registry}/${name}/-/${name.split("/")[1]}-${release?.version}.tgz`;
    if (release?.name !== name || !release.version || tarball !== exact || !integrity || !/^sha512-[a-zA-Z0-9+/]{86}==$/u.test(integrity)) {
      baselineRefusal(`missing stable coordinates or dist.integrity for ${name}@latest`);
    }
    return { name, version: release.version, integrity, tarball };
  }));
  coherentVersion(releases);
  return releases;
}

export async function downloadLatest(names: string[], directory: string): Promise<Pack[]> {
  const releases = await resolveLatest(names);
  mkdirSync(directory);
  // The exact-version tarball URL is npm's cache key. Reuse setup-node's npm
  // cache and never let a second packument lookup choose a different version.
  try {
    execFileSync("npm", ["pack", "--ignore-scripts", "--prefer-offline", "--pack-destination", directory, ...releases.map(release => release.tarball)], {
      cwd: directory, env: isolatedConsumerEnv(), stdio: "pipe", timeout: 45_000,
    });
  } catch {
    baselineRefusal(`could not fetch ${releases.map(({ name, version }) => `${name}@${version}`).join(", ")}`);
  }
  return releases.map(({ name, version, integrity }) => {
    const path = join(directory, `${name.replace("/", "-").slice(1)}-${version}.tgz`);
    let bytes: Buffer;
    try { bytes = readFileSync(path); } catch { baselineRefusal(`missing downloaded pack for ${name}@${version}`); }
    const actual = `sha512-${createHash("sha512").update(bytes).digest("base64")}`;
    if (actual !== integrity) baselineRefusal(`dist.integrity mismatch for ${name}@${version}; clear the cached tarball and retry`);
    return { path, name, version };
  });
}

export function localPacks(directory: string): Pack[] {
  try {
    return readdirSync(directory).filter(name => name.endsWith(".tgz")).sort().map(name => ({ path: join(directory, name) }));
  } catch {
    return baselineRefusal(`cannot read local pack directory ${directory}`);
  }
}

export function unpackSet(directory: string, packs: Pack[], expected: string[], side: "released" | "candidate") {
  const installed = new Map<string, { directory: string; manifest: Manifest }>();
  const refuse = side === "released" ? baselineRefusal : (detail: string): never => { throw new Error(`Released API candidate: ${detail}`); };
  if (packs.length !== expected.length) refuse(`missing or extra packs; expected ${expected.join(", ")}`);
  for (const pack of packs) {
    const runTar = (args: string[]) => execFileSync("tar", args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: 15_000 });
    let manifest: Manifest;
    try { manifest = JSON.parse(runTar(["-xOf", pack.path, "package/package.json"])) as Manifest; }
    catch { return refuse(`cannot read pack manifest from ${pack.path}`); }
    if (!manifest || !expected.includes(manifest.name) || installed.has(manifest.name)
      || (pack.name && pack.name !== manifest.name) || (pack.version && pack.version !== manifest.version)) {
      refuse(`unexpected or duplicate package identity ${manifest?.name}@${manifest?.version}`);
    }
    const target = join(directory, "node_modules", manifest.name);
    mkdirSync(target, { recursive: true });
    try { runTar(["-xzf", pack.path, "--strip-components=1", "-C", target]); }
    catch { return refuse(`cannot unpack ${manifest.name}@${manifest.version}`); }
    installed.set(manifest.name, { directory: target, manifest });
  }
  const manifests = [...installed.values()].map(({ manifest }) => manifest);
  const version = coherentVersion(manifests);
  for (const manifest of manifests) {
    for (const dependencies of [manifest.dependencies, manifest.peerDependencies, manifest.optionalDependencies]) {
      for (const [name, pin] of Object.entries(dependencies ?? {})) {
        if (name.startsWith("@openlup/") && installed.get(name)?.manifest.version !== pin) {
          refuse(`mixed peer pins: ${manifest.name}@${manifest.version} expects ${name}@${pin}`);
        }
      }
    }
  }
  return { directory, version, installed };
}
