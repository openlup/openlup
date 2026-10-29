// Read-only planning and digest-preserving copies. No dependency install or Docker daemon required.
import { execFileSync } from "node:child_process";
import { env as processEnvironment } from "node:process";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

export const MIRROR_REGISTRY = "ghcr.io/openlup";

const tagPattern = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u;
const repositoryPattern = /^[a-z0-9]+(?:[._-][a-z0-9]+)*(?:\/[a-z0-9]+(?:[._-][a-z0-9]+)*)+$/u;
const digestPattern = /^sha256:[a-f0-9]{64}$/u;
const cliRepositories = ["supabase/postgres", "supabase/gotrue", "supabase/realtime", "supabase/storage-api"];
const plannedRepositories = [...cliRepositories, "supabase/pg_prove"];

export function cliPin(workflow) {
  // Accept the repository's literal step format only; refuse expressions, duplicate steps or pins.
  const steps = workflow.split(/^ {6}- /mu).slice(1);
  const setups = steps.filter((step) => /(?:^uses: |^ {8}uses: )supabase\/setup-cli@/mu.test(step));
  const pins = setups[0]?.match(/^ {10}version: [0-9]+\.[0-9]+\.[0-9]+$/gmu) ?? [];
  if (setups.length !== 1 || pins.length !== 1) throw new Error("expected exactly one literal Supabase CLI pin in published-tree-ci.yml");
  return pins[0].trim().slice("version: ".length);
}

export function cliImages(services, binary, pgtapSource) {
  if (!Array.isArray(services) || !binary.includes("public.ecr.aws")) throw new Error("CLI services or upstream registry changed; re-derive the image set");
  // Read the runner's literal and its actual use; never import or execute the pgTAP runner.
  const exclusions = [...pgtapSource.matchAll(/^ {2}const excluded = "([a-z][a-z-]*(?:,[a-z][a-z-]*)*)";$/gmu)];
  if (exclusions.length !== 1 || (pgtapSource.match(/"--exclude", excluded/gu) ?? []).length !== 1) throw new Error("expected exactly one literal pgTAP exclusion list and use");
  const excluded = new Set(exclusions[0][1].split(","));
  if (excluded.has("postgres") || excluded.size !== exclusions[0][1].split(",").length) throw new Error("invalid pgTAP exclusion list");
  // CLI 5afad870: apps/cli/src/commands/start/start.gates.ts filters running services only.
  // Refuse a broader startup set: services omits kong/mailpit/imgproxy/vector.
  if ([...services.map((service) => service.name).filter((name) => !cliRepositories.includes(name)),
    "library/kong", "axllent/mailpit", "darthsim/imgproxy", "timberio/vector"]
    .some((name) => typeof name !== "string" || !excluded.has(name.split("/").at(-1)))) {
    throw new Error("pgTAP exclusion list leaves an uncovered runtime image");
  }
  const images = cliRepositories.map((repository) => {
    const entries = services.filter((service) => service.name === repository);
    if (entries.length !== 1 || typeof entries[0].local !== "string" || !tagPattern.test(entries[0].local)) throw new Error(`expected exactly one local service tag for ${repository}`);
    return { repository, tag: entries[0].local };
  });
  const prove = [...new Set(binary.match(/supabase\/pg_prove:[0-9][0-9A-Za-z._-]+/gu))];
  if (prove.length !== 1) throw new Error("expected exactly one supabase/pg_prove tag in the CLI binary");
  images.push({ repository: "supabase/pg_prove", tag: prove[0].split(":")[1] });
  // CLI 5afad870: apps/cli/src/command-internal/db-bootstrap initializes enabled auth,
  // realtime and storage with these images even when their services are excluded.
  // The rendered reference config enables all three; never subtract --exclude.
  return images;
}

// This is the write job's trust boundary: never accept registry, target or digest fields.
export function plannedImages(input) {
  const images = JSON.parse(input);
  if (!Array.isArray(images) || images.length > plannedRepositories.length) throw new Error("invalid CLI image plan");
  const repositories = new Set();
  for (const image of images) {
    if (!image || typeof image !== "object" || Array.isArray(image)
      || Object.keys(image).sort().join(",") !== "repository,tag"
      || !plannedRepositories.includes(image.repository)
      || typeof image.tag !== "string" || !tagPattern.test(image.tag)
      || repositories.has(image.repository)) throw new Error("invalid CLI image plan");
    repositories.add(image.repository);
  }
  return images.map((image) => ({ ...image, sources: [`public.ecr.aws/${image.repository}`, `docker.io/${image.repository}`] }));
}

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

// Bind the runtime-derived set to reviewed digests; never silently accept tag drift.
export function pinnedCliImages(images, config) {
  const pins = ownedImages({ images: config?.cliImages });
  if (pins.length !== images.length || new Set(images.map(image => image.repository)).size !== images.length
    || new Set(pins.map(pin => pin.repository)).size !== pins.length) {
    throw new Error("CLI image pins must cover the exact derived set");
  }
  return images.map(image => {
    const pin = pins.find(pin => pin.repository === image.repository && pin.tag === image.tag);
    if (!pin) throw new Error(`missing CLI image digest pin: ${image.repository}:${image.tag}`);
    return { ...image, digest: pin.digest, sources: image.sources ?? [...pin.sources] };
  });
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
  const failures = [];
  for (const source of image.sources) {
    const ref = `${source.includes(":") ? source : `${source}:${image.tag}`}${image.digest ? `@${image.digest}` : ""}`;
    let digest;
    try { digest = registryInspect(ref); } catch (error) { failures.push(String(error.message)); continue; }
    if (digest === null) { failures.push(`missing ${ref}`); continue; }
    if (!digestPattern.test(digest) || (image.digest && digest !== image.digest)) throw new Error(`source digest mismatch: ${ref}`);
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

export function deriveCliImages(root, directory) {
  const temporary = directory === undefined;
  // pgTAP checks its CLI version before passing its existing work directory.
  if (temporary) {
    const version = cliPin(readFileSync(join(root, ".github/workflows/published-tree-ci.yml"), "utf8"));
    if (command("supabase", ["--version"]).trim() !== version) throw new Error(`requires Supabase CLI ${version}`);
  }
  directory ??= mkdtempSync(join(tmpdir(), "ci-image-mirror-"));
  try {
    if (temporary) {
      mkdirSync(join(directory, "supabase"));
      // The same template as public-ci-pgtap.mjs; only disposable IDs/ports are rendered.
      const values = { PROJECT_ID: "ci-image-mirror", SHADOW_PORT: 55300, API_PORT: 55301, DB_PORT: 55302,
        STUDIO_PORT: 55303, MAIL_PORT: 55304, POOLER_PORT: 55309, APP_PORT: 55310 };
      const config = readFileSync(join(root, "config/public-reference-subscription-supabase.toml"), "utf8")
        .replace(/\{\{([A-Z_]+)\}\}/gu, (_, key) => {
          if (!(key in values)) throw new Error(`unknown Supabase config placeholder: ${key}`);
          return String(values[key]);
        });
      writeFileSync(join(directory, "supabase/config.toml"), config);
    }
    const services = JSON.parse(command("supabase", ["services", "--workdir", directory, "-o", "json"]));
    const binary = readFileSync(command("which", ["supabase"]).trim()).toString("latin1");
    const pgtapSource = readFileSync(join(root, "scripts/public-ci-pgtap.mjs"), "utf8");
    return cliImages(services, binary, pgtapSource);
  } finally { if (temporary) rmSync(directory, { recursive: true, force: true }); }
}

// Validate both inputs completely before the first exec or registry request.
export function resolvePlan(input, config, registryInspect = inspect) {
  const planned = plannedImages(input);
  const owned = ownedImages(config);
  const images = [...pinnedCliImages(planned, config), ...owned];
  const resolved = new Map();
  for (const image of images.map((image) => resolveImage(image, registryInspect))) {
    if (resolved.has(image.target) && resolved.get(image.target).digest !== image.digest) throw new Error(`conflicting derived target: ${image.target}`);
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
  if (mode === "pin") {
    console.log(`version=${cliPin(readFileSync(".github/workflows/published-tree-ci.yml", "utf8"))}`);
    return;
  }
  if (mode === "plan") {
    console.log(JSON.stringify(deriveCliImages(process.cwd())));
    return;
  }
  if (!["resolve", "mirror"].includes(mode)) throw new Error("usage: ci-image-mirror.mjs pin | plan | resolve | mirror");
  const images = resolvePlan(processEnvironment.PLAN_IMAGES, JSON.parse(readFileSync("config/ci-images.json", "utf8")));
  if (mode === "mirror") mirrorImages(images);
  else for (const image of images) console.log(`${image.source} -> ${image.target} @ ${image.digest}: planned`);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  try { main(); } catch (error) { console.error(error.message); process.exitCode = 1; }
}
