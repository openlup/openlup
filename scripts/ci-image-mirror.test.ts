import type { OwnedCiImage } from "./ci-image-mirror.mjs";
import { existsSync, readFileSync } from "node:fs";
import { env as processEnvironment } from "node:process";
import { describe, expect, it, vi } from "vitest";
import { inspect, mirrorImage, mirrorImages, ownedImages, resolveImage, resolvePlan } from "./ci-image-mirror.mjs";
import { execFileSync } from "node:child_process";

vi.mock("node:child_process", () => ({ execFileSync: vi.fn() }));

const digest = `sha256:${"a".repeat(64)}`;
const different = `sha256:${"b".repeat(64)}`;
const image = { repository: "library/postgres", tag: "16", digest, sources: ["docker.io/library/postgres", "public.ecr.aws/docker/library/postgres"] };
const resolved = { source: `docker.io/library/postgres@${digest}`, target: "ghcr.io/openlup/library/postgres:16", digest };
const batchSource = readFileSync("tests/postgres/reviewedBatchForwards.test.ts", "utf8");
const actualConfig = () => JSON.parse(readFileSync("config/ci-images.json", "utf8")) as { images: OwnedCiImage[] };

function assertSingleOwner(source: string) {
  expect(source).not.toMatch(/sha256:[a-f0-9]{64}/u);
  expect(source).not.toMatch(/\[[^\]\n]*["'`](?:ghcr\.io|docker\.io|public\.ecr\.aws)\//u);
}

describe("CI image mirror planning and digest preservation", () => {
  it("keeps reviewed-batch pins and source lists in the JSON reader only", () => {
    assertSingleOwner(batchSource);
    expect(batchSource).toContain('readCiImage("test-postgres")');
    expect(() => assertSingleOwner(`${batchSource}\nconst digest = "${digest}";`)).toThrow();
    expect(() => assertSingleOwner(`${batchSource}\nconst sources = ["docker.io/library/postgres"];`)).toThrow();
  });

  it("plans exactly the committed owned inventory, by pinned digest, with upstream-only sources", () => {
    const config = actualConfig();
    expect(Object.keys(config)).toEqual(["images"]);
    const lookup = vi.fn().mockImplementation((ref: string) => ref.split("@")[1]);
    const plan = resolvePlan(config, lookup);
    expect(plan.map(({ target }) => target)).toEqual(config.images.map(({ repository, tag }) => `ghcr.io/openlup/${repository}:${tag}`));
    expect(plan.map(({ digest }) => digest)).toEqual(config.images.map(({ digest }) => digest));
    expect(lookup.mock.calls.map(([ref]) => ref)).toEqual(config.images.map(({ sources, tag, digest }) => `${sources[0].includes(":") ? sources[0] : `${sources[0]}:${tag}`}@${digest}`));
    expect(config.images.every(({ sources }) => sources.every(source => !source.startsWith("ghcr.io/openlup/")))).toBe(true);
  });

  it("refuses two owned pins that would write different digests to one mirror target", () => {
    const first = { name: "first", ...image };
    const lookup = vi.fn().mockImplementation((ref: string) => ref.split("@")[1]);
    expect(resolvePlan({ images: [first, { ...first, name: "second" }] }, lookup)).toHaveLength(1);
    expect(() => resolvePlan({ images: [first, { ...first, name: "second", digest: different }] }, lookup)).toThrow("conflicting mirror target");
  });

  it("validates the owned pins and refuses duplicates, mutable or unsafe refs", () => {
    const config = JSON.parse(readFileSync("config/ci-images.json", "utf8"));
    expect(ownedImages(config).map(({ name }) => name)).toEqual(["install-proof-postgres", "test-postgres"]);
    for (const images of [[config.images[0], config.images[0]], [{ ...config.images[0], digest: "TODO" }],
      [{ ...config.images[0], sources: ["evil.test/library/postgres"] }], [{ ...config.images[0], tag: "16; echo unsafe" }]]) {
      expect(() => ownedImages({ images })).toThrow("invalid or duplicate");
    }
    for (const source of ["ghcr.io/library/postgres:16", "ghcr.io/library/postgres:17:extra", "ghcr.io/other/postgres:17"]) {
      expect(() => ownedImages({ images: [{ ...config.images[0], sources: [source] }] })).toThrow("invalid or duplicate");
    }
  });

  it("refuses missing, empty or mistyped owned fields before any exec or registry call", () => {
    const exec = vi.mocked(execFileSync).mockClear();
    const lookup = vi.fn();
    for (const field of ["name", "repository", "tag", "digest", "sources"]) {
      for (const value of [undefined, null, "", 17, {}, []]) {
        const changed: Record<string, unknown> = { ...actualConfig().images[0], [field]: value };
        if (value === undefined) delete changed[field];
        expect(() => resolvePlan({ images: [actualConfig().images[1], changed] }, lookup), `${field}: ${String(value)}`).toThrow("invalid or duplicate");
      }
    }
    expect(lookup).not.toHaveBeenCalled();
    expect(exec).not.toHaveBeenCalled();
  });

  it.each([false, true])("uses stdin login and removes temporary credentials after login failure=%s", (fail) => {
    vi.stubEnv("GHCR_TOKEN", "test-token");
    vi.stubEnv("GHCR_ACTOR", "test-actor");
    vi.stubEnv("DOCKER_CONFIG", "/previous-config");
    let directory = "";
    const exec = vi.mocked(execFileSync).mockReset().mockImplementation((_file, _args, options) => {
      directory = processEnvironment.DOCKER_CONFIG!;
      expect(existsSync(directory)).toBe(true);
      expect(directory).not.toBe("/previous-config");
      expect(options).toMatchObject({ input: "test-token", stdio: ["pipe", "pipe", "pipe"] });
      if (fail) throw new Error("login failed");
      return "";
    });
    try {
      if (fail) expect(() => mirrorImages([])).toThrow("login failed");
      else mirrorImages([]);
      expect(exec).toHaveBeenCalledExactlyOnceWith("docker", ["login", "ghcr.io", "--username", "test-actor", "--password-stdin"], expect.any(Object));
      expect(existsSync(directory)).toBe(false);
      expect(processEnvironment.DOCKER_CONFIG).toBe("/previous-config");
    } finally { vi.unstubAllEnvs(); }
  });

  it("resolves by pinned digest with ordered fallback and never accepts mismatch", () => {
    const lookup = vi.fn().mockImplementationOnce(() => { throw new Error("rate limited"); }).mockReturnValue(digest);
    expect(resolveImage(image, lookup)).toEqual({ ...resolved, source: `public.ecr.aws/docker/library/postgres@${digest}` });
    expect(lookup.mock.calls.map(([ref]) => ref)).toEqual(image.sources.map((source) => `${source}:16@${digest}`));
    expect(() => resolveImage(image, () => different)).toThrow("source digest mismatch");
    expect(() => resolveImage(image, () => null)).toThrow("no verified upstream");
    expect(() => resolveImage({ ...image, digest: undefined } as unknown as typeof image, () => digest)).toThrow("pinned digest");
  });

  it("preserves an explicit source tag without appending a second tag", () => {
    const [native] = ownedImages(actualConfig());
    const managed = ownedImages({ images: [{ ...native, sources: [`ghcr.io/library/postgres:${native.tag}`, ...native.sources] }] })[0];
    const lookup = vi.fn().mockReturnValue(managed.digest);
    expect(resolveImage(managed, lookup).source).toBe(`${managed.sources[0]}@${managed.digest}`);
    expect(lookup).toHaveBeenCalledExactlyOnceWith(`${managed.sources[0]}@${managed.digest}`);
  });

  it("skips identical targets, refuses conflicts and never copies after inspect failure", () => {
    const copy = vi.fn();
    expect(mirrorImage(resolved, () => digest, copy)).toBe("skipped");
    expect(() => mirrorImage(resolved, () => different, copy)).toThrow("refuse to overwrite");
    expect(() => mirrorImage(resolved, () => { throw new Error("401 unauthorized"); }, copy)).toThrow("401");
    expect(copy).not.toHaveBeenCalled();
  });

  it("copies the complete source by digest then verifies the target tag", () => {
    const lookup = vi.fn().mockReturnValueOnce(null).mockReturnValueOnce(digest);
    const copy = vi.fn();
    expect(mirrorImage(resolved, lookup, copy)).toBe("copied and verified");
    expect(copy).toHaveBeenCalledExactlyOnceWith(resolved.source, resolved.target);
    expect(lookup.mock.calls).toEqual([[resolved.target], [resolved.target]]);
    expect(() => mirrorImage(resolved, vi.fn().mockReturnValueOnce(null).mockReturnValueOnce(different), copy)).toThrow("post-copy digest verification failed");
    expect(() => mirrorImage(resolved, () => null, copy)).toThrow("post-copy digest verification failed");
  });

  it("treats only explicit missing manifests as absence", () => {
    const exec = vi.mocked(execFileSync);
    for (const stderr of ["ERROR: manifest unknown", "ERROR: ghcr.io/openlup/library/postgres:16: not found"]) {
      exec.mockImplementationOnce(() => { throw Object.assign(new Error("inspect"), { stderr }); });
      expect(inspect(resolved.target)).toBeNull();
    }
    for (const stderr of ["401 unauthorized", "429 Too Many Requests", "DNS failure", "repository does not exist or may require authorization"]) {
      exec.mockImplementationOnce(() => { throw Object.assign(new Error("inspect failed"), { stderr }); });
      expect(() => inspect(resolved.target)).toThrow("inspect failed");
    }
    exec.mockReturnValueOnce('{"mediaType":"application/vnd.oci.image.index.v1+json","manifests":[]}');
    expect(inspect(resolved.target)).toMatch(/^sha256:[a-f0-9]{64}$/u);
    exec.mockReturnValueOnce("not a manifest");
    expect(() => inspect(resolved.target)).toThrow();
  });

  it("uses a single carbon copy without platform filtering or format conversion", () => {
    const raw = '{"mediaType":"application/vnd.oci.image.index.v1+json","manifests":[]}';
    const exec = vi.mocked(execFileSync).mockReset().mockReturnValueOnce(raw);
    const actual = inspect(resolved.target);
    exec.mockReturnValueOnce("");
    expect(mirrorImage({ ...resolved, digest: actual }, vi.fn().mockReturnValueOnce(null).mockReturnValueOnce(actual))).toBe("copied and verified");
    expect(exec.mock.calls[1]?.slice(0, 2)).toEqual(["docker", ["buildx", "imagetools", "create", "--prefer-index=false", "--tag", resolved.target, resolved.source]]);
  });
});
