import { describe, expect, it, vi } from "vitest";
import { MIRROR_REGISTRY, ownedImages } from "./ci-image-mirror.mjs";
import { IMAGE_PULL_BUDGET_MS, IMAGE_PULL_FALLBACK_RESERVE_MS, imageIo, imageReference, mirrorUnavailable, pullWithRetry, readCiImage, resolvePinnedImage } from "./ci-image-pull.mjs";
import { CLI_IMAGE_PULL_BUDGET_MS, prePullCliImages } from "./public-ci-pgtap.mjs";
import { readFileSync } from "node:fs";

const pin = readCiImage("test-postgres");
function witness() {
  let elapsed = 0;
  const waits: number[] = [];
  const local = new Set<string>();
  const io = {
    pull: vi.fn(async (_reference: string, _timeout?: number) => ""),
    inspect: vi.fn(async (reference: string) => JSON.stringify([reference])),
    exec: vi.fn(async (args: string[], timeout?: number) => {
      if (args[0] === "pull") {
        await io.pull(args[1], timeout);
        local.add(args[1]);
      } else if (args[1] === "inspect") {
        if (!local.has(args[2])) throw new Error(`No such image: ${args[2]}`);
        return io.inspect(args[2]);
      } else if (args[1] === "tag") {
        if (!local.has(args[2])) throw new Error(`No such image: ${args[2]}`);
        local.add(args[3]);
      }
      return "";
    }),
    sleep: async (ms: number) => { waits.push(ms); elapsed += ms; },
    now: () => elapsed,
  };
  const pulls = () => io.exec.mock.calls.filter(([args]) => args[0] === "pull").map(([args]) => args[1]);
  return { io, waits, pulls, local };
}

describe.each(["test-postgres", "managed-batch-postgres"])("mirror-first CI image pulls (offline): %s", name => {
  const pin = readCiImage(name);
  it.each(pin.sources)("reuses the exact local index from %s before any pull", async source => {
    const { io, local, pulls, waits } = witness();
    const reference = imageReference(pin, source);
    local.add(reference);
    expect(await pullWithRetry(pin, io)).toBe(reference);
    expect(pulls()).toEqual([]);
    expect(waits).toEqual([]);
  });
  it("does not reuse a tag or a different index digest, and verifies the pull", async () => {
    const { io, local, pulls } = witness();
    local.add(`${pin.sources[0]}:${pin.tag}`);
    local.add(imageReference(pin));
    io.inspect.mockResolvedValueOnce(JSON.stringify([`${pin.sources[0]}@sha256:${"a".repeat(64)}`]));
    expect(await pullWithRetry(pin, io)).toBe(imageReference(pin));
    expect(pulls()).toEqual([imageReference(pin)]);
    expect(io.inspect).toHaveBeenCalledTimes(2);
  });
  it.each(["Cannot connect to the Docker daemon", "permission denied: docker.sock", "No such image; Cannot connect to the Docker daemon", "connection reset during inspect"])("refuses local inspection error before pulling: %s", async message => {
    const { io, pulls } = witness();
    io.exec.mockRejectedValueOnce(new Error(message));
    await expect(pullWithRetry(pin, io)).rejects.toThrow(message);
    expect(pulls()).toEqual([]);
  });
  it("reaches ECR on the shared postgres chain after long-hint registry 429s", async () => {
    const { io, waits, pulls } = witness();
    io.pull.mockImplementation(async reference => {
      if (!reference.startsWith("public.ecr.aws/")) throw new Error("toomanyrequests: 429 retry-after: 300, allowed: 44000/minute");
      return "";
    });
    const ecr = imageReference(pin, pin.sources.at(-1));
    expect(await pullWithRetry(pin, io)).toBe(ecr);
    expect(pulls()).toEqual(pin.sources.map(source => imageReference(pin, source)));
    expect(waits).toEqual([]);
  });
  it("prepends the sole mirror registry without changing JSON upstream inputs", () => {
    const config = JSON.parse(readFileSync("config/ci-images.json", "utf8"));
    for (const image of ownedImages(config)) {
      expect(readCiImage(image.name).sources).toEqual([`${MIRROR_REGISTRY}/${image.repository}`, ...image.sources]);
      expect(image.sources.some(source => source.startsWith(`${MIRROR_REGISTRY}/`))).toBe(false);
    }
    expect(() => readCiImage("absent")).toThrow("unknown CI image");
  });
  it("retries transient/transient/success exactly three times with two waits", async () => {
    const { io, waits, pulls } = witness();
    io.pull.mockRejectedValueOnce(new Error("connection reset")).mockRejectedValueOnce(new Error("503 service unavailable"));
    expect(await pullWithRetry(pin, io)).toBe(imageReference(pin));
    expect(pulls()).toEqual(Array(3).fill(imageReference(pin)));
    expect(waits).toEqual([1_000, 2_000]);
  });
  it("exhausts persistent 429 before the next source without a fourth call", async () => {
    const { io, waits, pulls } = witness();
    io.pull.mockRejectedValueOnce(new Error("429")).mockRejectedValueOnce(new Error("429")).mockRejectedValueOnce(new Error("429"));
    expect(await pullWithRetry(pin, io)).toBe(imageReference(pin, pin.sources[1]));
    expect(pulls()).toEqual([...Array(3).fill(imageReference(pin)), imageReference(pin, pin.sources[1])]);
    expect(waits).toEqual([1_000, 2_000]);
  });
  it.each([['488ns', 1_000], ['488µs', 1_000], ['488μs', 1_000], ['488us', 1_000],
    ['736.176µs', 1_000], ['736.176μs', 1_000], ['1500ms', 1_500], ['4', 4_000], ['4.5s', 4_500], ['5 seconds', 5_000], ['bogus', 1_000]])("parses retry-after %s exactly as the gate", async (hint, delay) => {
    const { io, waits } = witness();
    io.pull.mockRejectedValueOnce(new Error(`toomanyrequests: retry-after: ${hint}, allowed: 44000/minute`));
    await pullWithRetry(pin, io);
    expect(waits).toEqual([delay]);
  });
  it("advances immediately when Retry-After exceeds the source share", async () => {
    const { io, waits, pulls } = witness();
    io.pull.mockRejectedValueOnce(new Error("429 retry-after: 300"));
    expect(await pullWithRetry(pin, io)).toBe(imageReference(pin, pin.sources[1]));
    expect(waits).toEqual([]);
    expect(pulls()).toEqual(pin.sources.slice(0, 2).map(source => imageReference(pin, source)));
  });
  it("caps a hint within the source share at five seconds", async () => {
    const { io, waits, pulls } = witness();
    io.pull.mockRejectedValueOnce(new Error("429 retry-after: 60"));
    expect(await pullWithRetry(pin, io)).toBe(imageReference(pin));
    expect(waits).toEqual([5_000]);
    expect(pulls()).toHaveLength(2);
  });
  it("calculates the Retry-After share from the remaining budget", async () => {
    const { io, waits, pulls } = witness();
    io.pull.mockImplementationOnce(async () => {
      await io.sleep(IMAGE_PULL_BUDGET_MS - IMAGE_PULL_FALLBACK_RESERVE_MS - 10_000);
      throw new Error("429 retry-after: 6");
    });
    expect(await pullWithRetry(pin, io)).toBe(imageReference(pin, pin.sources[1]));
    expect(waits).toEqual([IMAGE_PULL_BUDGET_MS - IMAGE_PULL_FALLBACK_RESERVE_MS - 10_000]);
    expect(pulls()).toHaveLength(2);
  });
  it.each([500, 502, 503, 504, "context deadline exceeded"])("retries a transient registry error: %s", async status => {
    const { io, pulls, waits } = witness();
    io.pull.mockRejectedValueOnce(new Error(`received unexpected HTTP status: ${status}`));
    expect(await pullWithRetry(pin, io)).toBe(imageReference(pin));
    expect(pulls()).toHaveLength(2);
    expect(waits).toEqual([1_000]);
  });
  it("retries real execFile killed timeouts and falls through to ECR", async () => {
    const { io, pulls, waits } = witness();
    io.pull.mockImplementation(async reference => {
      if (!reference.startsWith("public.ecr.aws/")) {
        throw Object.assign(new Error('Command failed: docker pull X\n'), { killed: true, signal: 'SIGTERM' });
      }
      return "";
    });
    expect(await pullWithRetry(pin, io)).toBe(imageReference(pin, pin.sources.at(-1)));
    expect(pulls()).toEqual([
      ...pin.sources.slice(0, -1).flatMap(source => Array(3).fill(imageReference(pin, source))),
      imageReference(pin, pin.sources.at(-1)),
    ]);
    expect(waits).toEqual(pin.sources.slice(0, -1).flatMap(() => [1_000, 2_000]));
  });
  it("preserves a multi-minute healthy cold pull before using any fallback", async () => {
    const { io, pulls } = witness();
    io.pull.mockImplementationOnce(async (_reference, timeout) => {
      expect(timeout).toBe(IMAGE_PULL_BUDGET_MS - IMAGE_PULL_FALLBACK_RESERVE_MS);
      await io.sleep(timeout! - 1_000);
      return "";
    });
    expect(await pullWithRetry(pin, io)).toBe(imageReference(pin));
    expect(pulls()).toHaveLength(1);
    expect(io.now()).toBe(239_000);
  });
  it("gives a stalled first source a shared deadline and reaches fallback", async () => {
    const { io, pulls } = witness();
    io.pull.mockImplementationOnce(async (_reference, timeout) => {
      await io.sleep(timeout!);
      throw Object.assign(new Error("Command failed: docker pull X"), { killed: true });
    });
    expect(await pullWithRetry(pin, io)).toBe(imageReference(pin, pin.sources[1]));
    expect(pulls()).toEqual(pin.sources.slice(0, 2).map(source => imageReference(pin, source)));
    expect(io.now()).toBe(240_000);
    expect(io.pull.mock.calls[1][1]).toBe(IMAGE_PULL_FALLBACK_RESERVE_MS / (pin.sources.length - 1));
  });
  it("exhausts all source deadlines within one global pull budget", async () => {
    const { io, pulls } = witness();
    io.pull.mockImplementation(async (_reference, timeout) => {
      await io.sleep(timeout!);
      throw Object.assign(new Error("Command failed: docker pull X"), { killed: true });
    });
    await expect(pullWithRetry(pin, io)).rejects.toThrow(`within ${IMAGE_PULL_BUDGET_MS / 1_000}s; no source succeeded`);
    expect(io.now()).toBe(IMAGE_PULL_BUDGET_MS);
    expect(pulls()).toEqual(pin.sources.map(source => imageReference(pin, source)));
  });
  it("keeps the full cold pull budget for a single source", async () => {
    const { io } = witness();
    expect(await pullWithRetry({ ...pin, sources: pin.sources.slice(0, 1) }, io)).toBe(imageReference(pin));
    expect(io.pull).toHaveBeenCalledExactlyOnceWith(imageReference(pin), IMAGE_PULL_BUDGET_MS);
  });
  it("clamps a fractional millisecond to one", async () => {
    const { io } = witness();
    expect(await pullWithRetry({ ...pin, sources: pin.sources.slice(0, 1) }, io, 0.25)).toBe(imageReference(pin));
    expect(io.pull).toHaveBeenCalledExactlyOnceWith(imageReference(pin), 1);
  });
  it("caps a retry wait at the remaining global budget without another pull", async () => {
    const { io, pulls, waits } = witness();
    io.pull.mockImplementationOnce(async () => {
      await io.sleep(IMAGE_PULL_BUDGET_MS - 500);
      throw new Error("connection timed out");
    });
    await expect(pullWithRetry({ ...pin, sources: pin.sources.slice(0, 1) }, io)).rejects.toThrow("no source succeeded");
    expect(waits).toEqual([IMAGE_PULL_BUDGET_MS - 500, 500]);
    expect(io.now()).toBe(IMAGE_PULL_BUDGET_MS);
    expect(pulls()).toHaveLength(1);
  });
  it.each(["manifest unknown", "manifest_unknown", "not found", "denied", "unauthorized", "authentication required"])("falls through an empty/private mirror: %s", async message => {
    const { io, waits, pulls } = witness();
    io.pull.mockRejectedValueOnce(Object.assign(new Error("docker pull failed"), { stderr: message }));
    expect(await pullWithRetry(pin, io)).toBe(imageReference(pin, pin.sources[1]));
    expect(pulls()).toEqual(pin.sources.slice(0, 2).map(source => imageReference(pin, source)));
    expect(waits).toEqual([]);
  });
  it("refuses an upstream not-found on the last source", async () => {
    const { io, waits, pulls } = witness();
    const last = { ...pin, sources: [pin.sources.at(-1)!] };
    io.pull.mockRejectedValueOnce(new Error("manifest unknown"));
    await expect(pullWithRetry(last, io)).rejects.toThrow("manifest unknown");
    expect(pulls()).toHaveLength(1);
    expect(waits).toEqual([]);
  });
  it.each(["Cannot connect to the Docker daemon", "error during connect: connection refused", "error during connect: EOF", "dial unix docker.sock: EOF", "no space left on device", "invalid reference format", "ENOENT", "unauthorized"])("refuses local/fatal upstream failure without retries: %s", async message => {
    const { io, pulls, waits } = witness();
    io.pull.mockRejectedValueOnce(new Error(message));
    await expect(pullWithRetry({ ...pin, sources: pin.sources.slice(1) }, io)).rejects.toThrow(message);
    expect(pulls()).toHaveLength(1);
    expect(waits).toEqual([]);
  });
  it("refuses local disk errors even when the mirror message contains denied", async () => {
    const { io, pulls } = witness();
    io.pull.mockRejectedValueOnce(new Error("denied: no space left on device"));
    await expect(pullWithRetry(pin, io)).rejects.toThrow("no space");
    expect(pulls()).toHaveLength(1);
    expect(mirrorUnavailable(pin.sources[0], "permission denied: docker.sock")).toBe(false);
  });
  it("refuses RepoDigest mismatch and inspection failures outside retries", async () => {
    for (const result of ["[]", new Error("connection reset during inspect")]) {
      const { io, pulls, waits } = witness();
      if (typeof result === "string") io.inspect.mockResolvedValueOnce(result);
      else io.inspect.mockRejectedValueOnce(result);
      await expect(pullWithRetry(pin, io)).rejects.toThrow(typeof result === "string" ? "exact pinned RepoDigest" : result.message);
      expect(pulls()).toHaveLength(1);
      expect(waits).toEqual([]);
    }
  });
  it("accepts the upstream canonical RepoDigest spelling", async () => {
    const { io } = witness();
    io.inspect.mockResolvedValueOnce(JSON.stringify([imageReference(pin, pin.sources[1]).replace(/^docker\.io\/(?:library\/)?/u, "").replace(/:[^/@]+@/u, "@")]));
    expect(await pullWithRetry({ ...pin, sources: pin.sources.slice(1) }, io)).toBe(imageReference(pin, pin.sources[1]));
  });
  it("keeps all fallback digests immutable and bounds total pulls at three per source", async () => {
    const { io, pulls, waits } = witness();
    io.pull.mockRejectedValue(new Error("network EOF"));
    await expect(pullWithRetry(pin, io)).rejects.toThrow("no source succeeded");
    expect(pulls()).toEqual(pin.sources.flatMap(source => Array(3).fill(imageReference(pin, source))));
    expect(waits).toEqual(pin.sources.flatMap(() => [1_000, 2_000]));
  });
  it("reuses an explicitly supplied verified local pin without a second pull phase", async () => {
    const { io, pulls, local } = witness();
    const reference = imageReference(pin, pin.sources[1]);
    local.add(reference);
    expect(await resolvePinnedImage(pin, reference, io)).toBe(reference);
    expect(pulls()).toEqual([]);
  });
  it("pulls a missing explicit pin, but refuses local mismatch/daemon failures", async () => {
    const { io, pulls } = witness();
    expect(await resolvePinnedImage(pin, imageReference(pin), io)).toBe(imageReference(pin));
    expect(pulls()).toHaveLength(1);
    for (const error of [new Error("Cannot connect to the Docker daemon"), new Error("exact pinned RepoDigest mismatch")]) {
      const witnessIo = witness();
      witnessIo.io.exec.mockRejectedValueOnce(error);
      await expect(resolvePinnedImage(pin, imageReference(pin), witnessIo.io)).rejects.toThrow(error.message);
      expect(witnessIo.pulls()).toEqual([]);
    }
  });
  it("refuses malformed inputs before any Docker operation", async () => {
    const { io } = witness();
    await expect(pullWithRetry({ ...pin, digest: "wrong" }, io)).rejects.toThrow("malformed");
    expect(io.exec).not.toHaveBeenCalled();
  });
});

it("uses performance.now for the production monotonic clock", () => {
  const clock = vi.spyOn(performance, "now").mockReturnValue(123.25);
  try { expect(imageIo.now()).toBe(123.25); } finally { clock.mockRestore(); }
});

describe("pgTAP pre-pull registry selection (offline)", () => {
  const images = ["postgres", "gotrue", "realtime", "storage-api", "pg_prove"].map(name => ({ repository: `supabase/${name}`, tag: "1.2.3" }));
  it("bounds the whole pre-pull stage and refuses another image on expiry", async () => {
    const { io, pulls } = witness();
    // Two slow successful cold images consume 480s of the stage budget.
    let cold = 0;
    io.pull.mockImplementation(async (_reference, timeout) => {
      cold += 1;
      if (cold <= 2) { await io.sleep(240_000); return ""; }
      await io.sleep(timeout!);
      throw Object.assign(new Error("registry pull timed out"), { killed: true });
    });
    await expect(prePullCliImages(images, io)).rejects.toThrow("no source succeeded");
    expect(io.now()).toBe(CLI_IMAGE_PULL_BUDGET_MS);
    expect(pulls().some(reference => reference.includes("storage-api"))).toBe(false);
  });
  it("includes aliasing and final local inspection in the aggregate budget", async () => {
    const { io } = witness();
    const execute = io.exec.getMockImplementation()!;
    io.exec.mockImplementation(async (args, timeout) => {
      if (args[0] === "pull") await io.sleep(239_000);
      if (args[1] === "tag") await io.sleep(361_000);
      return execute(args, timeout);
    });
    await expect(prePullCliImages([{ ...images[0], digest: pin.digest }], io)).rejects.toThrow("600s aggregate budget");
    expect(io.exec.mock.calls.filter(([args]) => args[1] === "inspect")).toHaveLength(5);
  });
  it("reaches ECR after long-hint 429s from each GHCR source per image, preserving supplied pins", async () => {
    const { io, pulls, waits } = witness();
    io.pull.mockImplementation(async reference => {
      if (reference.startsWith("ghcr.io/")) throw new Error("toomanyrequests: 429 retry-after: 300, allowed: 44000/minute");
      return "";
    });
    const pinned = images.map(image => ({ ...image, digest: pin.digest }));
    expect(await prePullCliImages(pinned, io)).toBe("public.ecr.aws");
    expect(pulls()).toEqual(pinned.flatMap(image => [
      `${MIRROR_REGISTRY}/${image.repository}:${image.tag}@${pin.digest}`,
      `ghcr.io/${image.repository}:${image.tag}@${pin.digest}`,
      `public.ecr.aws/${image.repository}:${image.tag}@${pin.digest}`,
    ]));
    expect(waits).toEqual([]);
  });
  it("reuses exact local CLI tags, including ECR, with zero pulls", async () => {
    const { io, local, pulls } = witness();
    for (const image of images) local.add(`public.ecr.aws/${image.repository}:${image.tag}`);
    expect(await prePullCliImages(images, io)).toBe("public.ecr.aws");
    expect(pulls()).toEqual([]);
  });
  it("does not reuse a different CLI tag", async () => {
    const { io, local, pulls } = witness();
    local.add(`${MIRROR_REGISTRY}/${images[0].repository}:different`);
    expect(await prePullCliImages([images[0]], io)).toBe(MIRROR_REGISTRY);
    expect(pulls()).toEqual([`${MIRROR_REGISTRY}/${images[0].repository}:${images[0].tag}`]);
  });
  it("uses the mirror when it supplies all five derived tags", async () => {
    const { io, pulls } = witness();
    expect(await prePullCliImages(images, io)).toBe(MIRROR_REGISTRY);
    expect(pulls()).toEqual(images.map(image => `${MIRROR_REGISTRY}/${image.repository}:${image.tag}`));
    expect(io.exec.mock.calls.some(([args]) => args[1] === "tag")).toBe(false);
  });
  it("uses GHCR after empty mirror failures without any wait", async () => {
    const { io, pulls, waits } = witness();
    io.pull.mockImplementation(async reference => {
      if (reference.startsWith(`${MIRROR_REGISTRY}/`)) throw new Error("unauthorized");
      return "";
    });
    expect(await prePullCliImages(images, io)).toBe("ghcr.io");
    expect(pulls()).toEqual(images.flatMap(image => [`${MIRROR_REGISTRY}/${image.repository}:${image.tag}`, `ghcr.io/${image.repository}:${image.tag}`]));
    expect(waits).toEqual([]);
  });
  it("aliases mixed successes into the first image's registry without re-pulling", async () => {
    const { io, pulls } = witness();
    io.pull.mockImplementation(async reference => {
      if (reference.startsWith(`${MIRROR_REGISTRY}/supabase/realtime`)) throw new Error("not found");
      return "";
    });
    expect(await prePullCliImages(images, io)).toBe(MIRROR_REGISTRY);
    expect(pulls()).toHaveLength(6);
    expect(io.exec).toHaveBeenCalledWith(["image", "tag", "ghcr.io/supabase/realtime:1.2.3", `${MIRROR_REGISTRY}/supabase/realtime:1.2.3`], 5_000);
    expect(io.exec.mock.calls.slice(-5).map(([args]) => args)).toEqual(images.map(image => ["image", "inspect", `${MIRROR_REGISTRY}/${image.repository}:${image.tag}`]));
  });
  it("aliases a verified digest pull to the CLI tag even in the same registry", async () => {
    const { io } = witness();
    expect(await prePullCliImages([{ ...images[0], digest: pin.digest }], io)).toBe(MIRROR_REGISTRY);
    expect(io.exec).toHaveBeenCalledWith(["image", "tag", `${MIRROR_REGISTRY}/supabase/postgres:1.2.3@${pin.digest}`, `${MIRROR_REGISTRY}/supabase/postgres:1.2.3`], 5_000);
  });
  it("verifies a digest when supplied by derivation", async () => {
    const { io } = witness();
    io.inspect.mockResolvedValueOnce("[]");
    await expect(prePullCliImages([{ ...images[0], digest: pin.digest }], io)).rejects.toThrow("RepoDigest");
  });
});
