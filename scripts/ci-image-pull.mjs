// Complete Docker pulls with local reuse and bounded registry fallback.
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import ciImages from "../config/ci-images.json" with { type: "json" };
import { MIRROR_REGISTRY, ownedImages } from "./ci-image-mirror.mjs";

const execFileAsync = promisify(execFile);
// A cold PG17 pull includes a ~358 MB layer that classic Docker cannot resume.
// Leave half the gate's 600s hook for startup/migrations. Keep a multi-minute
// cold pull opportunity, reserving 60s across fallback sources; this execution
// budget is not a throughput SLA. Retries share their source's deadline.
export const IMAGE_PULL_BUDGET_MS = 300_000;
export const IMAGE_PULL_ATTEMPTS = 3;
export const IMAGE_PULL_FALLBACK_RESERVE_MS = 60_000;
const MAX_RETRY_WAIT_MS = 5_000;
const localFailure = /ENOENT|cannot connect to the docker daemon|is the docker daemon running|error during connect|docker\.sock|no space left|disk quota|read-only file system|invalid reference|invalid tag|unsupported protocol/iu;
export const imageIo = {
  exec: async (args, timeout = 5_000) => {
    const pending = execFileAsync("docker", args, { timeout, maxBuffer: 64 * 1024 * 1024 });
    pending.child.stdin?.end();
    const { stdout } = await pending;
    return stdout;
  },
  sleep: async (ms) => { await new Promise(resolve => setTimeout(resolve, ms)); },
  now: () => performance.now(),
};

export function readCiImages() {
  return ownedImages(ciImages)
    .map(image => ({ ...image, sources: [`${MIRROR_REGISTRY}/${image.repository}`, ...image.sources] }));
}

export function readCiImage(name) {
  const image = readCiImages().find(image => image.name === name);
  if (!image) throw new Error(`unknown CI image: ${name}`);
  return image;
}

export function imageReference(image, source = image.sources[0]) {
  return `${source.includes(":") ? source : `${source}:${image.tag}`}@${image.digest}`;
}

export function mirrorUnavailable(source, message) {
  return source.startsWith(`${MIRROR_REGISTRY}/`) && !localFailure.test(message)
    && /manifest unknown|manifest_unknown|not found|denied|unauthorized|authentication required|401|403/iu.test(message);
}

const canonical = value => value.replace(/^docker\.io\/(?:library\/)?/u, "").replace(/:[^/@]+@/u, "@");
const inspect = (reference, io) => io.exec(["image", "inspect", reference, "--format", "{{json .RepoDigests}}"]);
const matchesPin = (digests, reference, digest) => Array.isArray(digests)
  && digests.map(canonical).includes(canonical(reference)) && reference.endsWith(`@${digest}`);

async function verifyPinnedImage(reference, digest, io) {
  if (!matchesPin(JSON.parse(await inspect(reference, io)), reference, digest)) {
    throw new Error(`pulled image must have the exact pinned RepoDigest: ${reference}`);
  }
  return reference;
}

// An explicit pinned override may already have been resolved by the gate.
// Verify that exact local ref instead of nesting two pull phases.
export async function resolvePinnedImage(image, reference, io = imageIo) {
  try { return await verifyPinnedImage(reference, image.digest, io); } catch (error) {
    if (!/no such image/iu.test([error.message, error.stderr].join("\n"))) throw error;
    return pullWithRetry(image, io);
  }
}

export async function pullWithRetry(image, io = imageIo, budgetMs = IMAGE_PULL_BUDGET_MS) {
  if (!Number.isFinite(budgetMs) || budgetMs <= 0 || budgetMs > IMAGE_PULL_BUDGET_MS) throw new Error("invalid image pull budget");
  const deadline = io.now() + budgetMs;
  // Include local probes and final pin verification in the caller's budget.
  const boundedIo = { ...io, exec: (args, timeout = 5_000) => {
    const remaining = deadline - io.now();
    if (remaining <= 0) throw new Error(`Image pull budget exhausted for ${image.repository}`);
    return io.exec(args, Math.max(1, Math.ceil(Math.min(timeout, remaining))));
  } };
  // Every pull is digest-pinned; a tag alone never selects an image.
  if (!/^[a-z0-9]+(?:[._/-][a-z0-9]+)+$/u.test(image.repository)
    || !/^[A-Za-z0-9_][A-Za-z0-9_.-]{0,127}$/u.test(image.tag)
    || typeof image.digest !== "string" || !/^sha256:[a-f0-9]{64}$/u.test(image.digest)
    || !Array.isArray(image.sources) || image.sources.length === 0
    || image.sources.some(source => !/^(?:ghcr\.io|docker\.io|public\.ecr\.aws)\/[a-z0-9]+(?:[._/-][a-z0-9]+)+(?::[A-Za-z0-9_][A-Za-z0-9_.-]{0,127})?$/u.test(source) || (source.includes(":") && source.split(":")[1] !== image.tag))) {
    throw new Error("malformed CI image reference");
  }
  // Probe every source before the first pull: a fallback pin may already be
  // local even when the preferred mirror is unreachable. Only "No such image"
  // is an ignorable inspection error; daemon/permission failures refuse.
  for (const source of image.sources) {
    const reference = imageReference(image, source);
    let result;
    try { result = await inspect(reference, boundedIo); } catch (error) {
      const message = [error?.message, error?.stderr].filter(Boolean).join("\n");
      if (!localFailure.test(message) && /no such image/iu.test(message)) continue;
      throw error;
    }
    // Reuse requires index equality, never a nearby tag or an unrelated RepoDigest.
    if (matchesPin(JSON.parse(result), reference, image.digest)) return reference;
  }
  const failures = [];
  const reserve = Math.min(IMAGE_PULL_FALLBACK_RESERVE_MS, budgetMs / 5);
  for (const [sourceIndex, source] of image.sources.entries()) {
    const reference = imageReference(image, source);
    const sourceDeadline = deadline - (image.sources.length === 1 ? 0
      : reserve * (image.sources.length - sourceIndex - 1) / (image.sources.length - 1));
    for (let attempt = 0; attempt < IMAGE_PULL_ATTEMPTS; attempt += 1) {
      const remaining = sourceDeadline - io.now();
      if (remaining <= 0) break;
      try {
        await boundedIo.exec(["pull", reference], Math.max(1, Math.ceil(remaining)));
      } catch (error) {
        const message = [error instanceof Error ? error.message : String(error), error?.stderr, error?.stdout].filter(Boolean).join("\n");
        // These are local failures even if Docker also says "connection"/"denied".
        if (localFailure.test(message)) throw error;
        if (mirrorUnavailable(source, message)) { failures.push(`${reference}: ${message}`); break; }
        if (!/toomanyrequests|too many requests|429|\b5\d\d\b|context deadline exceeded|timed?\s*out|timeout|ETIMEDOUT|ECONN|ENOTFOUND|EAI_AGAIN|no such host|connection|network|TLS handshake|\bEOF\b/iu.test(message)
          && !(error instanceof Error && "killed" in error && error.killed === true)) throw error;
        failures.push(`${reference} attempt ${attempt + 1}: ${message}`);
        if (attempt < IMAGE_PULL_ATTEMPTS - 1) {
          const retryAfter = /retry-after:\s*(\d+(?:\.\d+)?)\s*(ns|[µμu]s|ms|s(?:ec(?:ond)?s?)?)?(?![\wµμ])/iu.exec(message);
          const unit = retryAfter?.[2]?.toLowerCase();
          const retryMs = retryAfter ? Number(retryAfter[1]) * (unit === "ns" ? 0.000001
            : unit && ["µs", "μs", "us"].includes(unit) ? 0.001 : unit === "ms" ? 1 : 1_000) : 0;
          const remainingWait = sourceDeadline - io.now();
          // A registry asking for more than its share should not starve the
          // next source. Shorter hints retain the existing five-second cap.
          if (remainingWait <= 0 || retryMs > remainingWait / (image.sources.length - sourceIndex)) break;
          await io.sleep(Math.min(MAX_RETRY_WAIT_MS, Math.max(1_000 * (attempt + 1), retryMs), remainingWait));
        }
        continue;
      }
      // Inspection is deliberately outside retries, including its transport errors.
      await verifyPinnedImage(reference, image.digest, boundedIo);
      return reference;
    }
  }
  throw new Error(`Could not pull ${image.repository} within ${budgetMs / 1_000}s; no source succeeded:\n${failures.join("\n")}`);
}
