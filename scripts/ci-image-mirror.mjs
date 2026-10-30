// Read-only planning and digest-preserving copies. No dependency install or Docker daemon required.
import { execFileSync } from "node:child_process";
import { env as processEnvironment } from "node:process";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

export const MIRROR_REGISTRY = "ghcr.io/openlup";

const tagPattern = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u;
const repositoryPattern = /^[a-z0-9]+(?:[._-][a-z0-9]+)*(?:\/[a-z0-9]+(?:[._-][a-z0-9]+)*)+$/u;
const digestPattern = /^sha256:[a-f0-9]{64}$/u;

function validOwnedSource(source, image) {
  if (typeof source !== "string") return false;
  const [repository, tag, extra] = source.split(":");
  return extra === undefined && (tag === undefined || tag === image.tag)
    && ["docker.io/", "public.ecr.aws/", "ghcr.io/"].some((prefix) => repository.startsWith(prefix))
    && repositoryPattern.test(repository.slice(repository.indexOf("/") + 1)) && repository.endsWith(`/${image.repository}`);
}

export function ownedImages(config) {
  if (!config || !Array.isArray(config.images) || config.images.length === 0) throw new Error("missing owned CI image pins");
  const names = new Set();
  for (const image of config.images) {
    if (!image || ["name", "repository", "tag", "digest"].some((field) => typeof image[field] !== "string" || image[field].length === 0)
      || !/^[a-z][a-z0-9-]+$/u.test(image.name) || names.has(image.name)
      || !repositoryPattern.test(image.repository) || !tagPattern.test(image.tag) || !digestPattern.test(image.digest)
      || !Array.isArray(image.sources) || image.sources.length === 0
      || image.sources.some((source) => !validOwnedSource(source, image))) {
      throw new Error("invalid or duplicate owned CI image pin");
    }
    names.add(image.name);
  }
  return config.images;
}

function command(file, args) {
  return execFileSync(file, args, { encoding: "utf8", maxBuffer: 64 * 1024 * 1024, stdio: ["ignore", "pipe", "pipe"] });
}

export function inspect(ref) {
  try {
    const raw = command("docker", ["buildx", "imagetools", "inspect", "--raw", ref]);
    const manifest = JSON.parse(raw);
    if (!["application/vnd.oci.image.index.v1+json", "application/vnd.docker.distribution.manifest.list.v2+json",
      "application/vnd.oci.image.manifest.v1+json", "application/vnd.docker.distribution.manifest.v2+json"].includes(manifest.mediaType)) {
      throw new Error(`unsupported manifest format: ${ref}`);
    }
    return `sha256:${createHash("sha256").update(raw).digest("hex")}`;
  } catch (error) {
    // Only an explicit missing manifest is absence. Authentication, throttling and transport errors refuse writes.
    if (/manifest unknown|manifest_unknown|:\s*not found\s*$/imu.test(String(error.stderr))) return null;
    throw error;
  }
}

export function resolveImage(image, registryInspect = inspect) {
  if (!digestPattern.test(image.digest ?? "")) throw new Error(`mirror requires a pinned digest: ${image.repository}:${image.tag}`);
  const failures = [];
  for (const source of image.sources) {
    const ref = `${source.includes(":") ? source : `${source}:${image.tag}`}@${image.digest}`;
    let digest;
    try { digest = registryInspect(ref); } catch (error) { failures.push(String(error.message)); continue; }
    if (digest === null) { failures.push(`missing ${ref}`); continue; }
    if (digest !== image.digest) throw new Error(`source digest mismatch: ${ref}`);
    return { source: `${source}@${digest}`, target: `${MIRROR_REGISTRY}/${image.repository}:${image.tag}`, digest };
  }
  throw new Error(`no verified upstream for ${image.repository}:${image.tag}: ${failures.join("; ")}`);
}

export function mirrorImage(image, registryInspect = inspect, copy = (source, target) => {
  command("docker", ["buildx", "imagetools", "create", "--prefer-index=false", "--tag", target, source]);
}) {
  const existing = registryInspect(image.target);
  if (existing === image.digest) return "skipped";
  if (existing !== null) throw new Error(`refuse to overwrite different digest at ${image.target}: ${existing}`);
  copy(image.source, image.target);
  if (registryInspect(image.target) !== image.digest) throw new Error(`post-copy digest verification failed: ${image.target}`);
  return "copied and verified";
}

// Validate the whole committed inventory before the first exec or registry request.
export function resolvePlan(config, registryInspect = inspect) {
  const resolved = new Map();
  for (const image of ownedImages(config).map((image) => resolveImage(image, registryInspect))) {
    if (resolved.has(image.target) && resolved.get(image.target).digest !== image.digest) throw new Error(`conflicting mirror target: ${image.target}`);
    resolved.set(image.target, image);
  }
  return [...resolved.values()];
}

export function mirrorImages(images) {
  const directory = mkdtempSync(join(tmpdir(), "ci-image-mirror-docker-"));
  const previous = processEnvironment.DOCKER_CONFIG;
  processEnvironment.DOCKER_CONFIG = directory;
  try {
    execFileSync("docker", ["login", "ghcr.io", "--username", processEnvironment.GHCR_ACTOR, "--password-stdin"], {
      input: processEnvironment.GHCR_TOKEN, encoding: "utf8", stdio: ["pipe", "pipe", "pipe"],
    });
    for (const image of images) console.log(`${image.target} @ ${image.digest}: ${mirrorImage(image)}`);
  } finally {
    if (previous === undefined) delete processEnvironment.DOCKER_CONFIG;
    else processEnvironment.DOCKER_CONFIG = previous;
    rmSync(directory, { recursive: true, force: true });
  }
}

function main() {
  const mode = process.argv[2];
  if (!["resolve", "mirror"].includes(mode)) throw new Error("usage: ci-image-mirror.mjs resolve | mirror");
  const images = resolvePlan(JSON.parse(readFileSync("config/ci-images.json", "utf8")));
  if (mode === "mirror") mirrorImages(images);
  else for (const image of images) console.log(`${image.source} -> ${image.target} @ ${image.digest}: planned`);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  try { main(); } catch (error) { console.error(error.message); process.exitCode = 1; }
}
